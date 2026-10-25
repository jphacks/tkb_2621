"""対面交換（spec 6章）。セッションはメモリ上に持つ（Render は1台なので DB は使わない）。"""

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import TypeAdapter, ValidationError

from . import pds
from .auth import authenticate_websocket, require_did
from .config import JOIN_URL_BASE
from .schemas import (
    BothConfirmedMessage,
    CancelledMessage,
    ClientMessage,
    CommitRequest,
    CommitResponse,
    CompletedMessage,
    ConfirmMessage,
    CreateSessionRequest,
    CreateSessionResponse,
    ExchangeView,
    JoinRequest,
    PartnerSelectedMessage,
    SelectMessage,
    SessionState,
    SessionStatus,
    StrongRef,
)

logger = logging.getLogger(__name__)

router = APIRouter()

JOIN_TOKEN_SECONDS = 60
# 作ってからこの時間のうちに2人の確定がそろわなければ破棄する
CONFIRM_TIMEOUT_SECONDS = 180
# 確定のあとも commit を待つので残す。メモリ掃除のため、作ってからこの時間で消す
SESSION_LIFETIME_SECONDS = 600

EXCHANGE_COLLECTION = "com.kosora623.pikkles.exchange"
STICKER_COLLECTION = "com.kosora623.pikkles.sticker"

_client_message = TypeAdapter(ClientMessage)


@dataclass
class Session:
    id: str
    a: str
    occasion: str | None
    b: str | None = None
    status: SessionStatus = "waiting"
    join_tokens: dict[str, float] = field(default_factory=dict)  # 合言葉 → 失効する時刻
    selected: dict[str, StrongRef] = field(default_factory=dict)
    confirmed: set[str] = field(default_factory=set)
    commits: dict[str, str] = field(default_factory=dict)  # DID → exchange レコードの URI
    sockets: dict[str, WebSocket] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    timer: asyncio.Task | None = None

    def members(self) -> tuple[str, ...]:
        return (self.a, self.b) if self.b else (self.a,)

    def partner_of(self, did: str) -> str | None:
        return self.b if did == self.a else self.a

    def state(self) -> SessionState:
        return SessionState(sessionId=self.id, occasion=self.occasion, status=self.status)


_sessions: dict[str, Session] = {}


def _new_join_url(session: Session) -> str:
    now = time.monotonic()
    session.join_tokens = {t: exp for t, exp in session.join_tokens.items() if exp > now}
    token = secrets.token_urlsafe(16)
    session.join_tokens[token] = now + JOIN_TOKEN_SECONDS
    return f"{JOIN_URL_BASE}/exchange/join/{session.id}?t={token}"


async def _send(session: Session, did: str, message) -> None:
    ws = session.sockets.get(did)
    if ws is None:
        return
    try:
        await ws.send_json(message.model_dump(mode="json"))
    except Exception as e:  # 切れた接続は捨てる
        logger.info("session %s: send %s to %s failed: %s: %s", session.id, message.type, did, type(e).__name__, e)
        session.sockets.pop(did, None)


async def _expire(session: Session) -> None:
    await asyncio.sleep(CONFIRM_TIMEOUT_SECONDS)
    if session.status in ("waiting", "selecting"):
        session.status = "cancelled"
        logger.info("session %s cancelled (timeout)", session.id)
        for did in session.members():
            await _send(session, did, CancelledMessage(type="cancelled", reason="3分間確定されなかったためキャンセルされました"))
            ws = session.sockets.pop(did, None)
            if ws is not None:
                try:
                    await ws.close()
                except Exception:
                    pass
        _sessions.pop(session.id, None)
        return
    await asyncio.sleep(max(0, SESSION_LIFETIME_SECONDS - CONFIRM_TIMEOUT_SECONDS))
    _sessions.pop(session.id, None)


def _get_session(session_id: str) -> Session:
    session = _sessions.get(session_id)
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "セッションが見つかりません")
    return session


@router.post("/exchange/sessions")
async def create_session(body: CreateSessionRequest, did: str = Depends(require_did)) -> CreateSessionResponse:
    occasion = (body.occasion or "").strip() or None
    session = Session(id=secrets.token_urlsafe(12), a=did, occasion=occasion)
    session.timer = asyncio.create_task(_expire(session))
    _sessions[session.id] = session
    return CreateSessionResponse(sessionId=session.id, joinUrl=_new_join_url(session))


@router.get("/exchange/sessions/{session_id}/qr")
async def refresh_qr(session_id: str, did: str = Depends(require_did)) -> CreateSessionResponse:
    session = _get_session(session_id)
    if did != session.a:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "セッションを始めた人だけが QR を作れます")
    if session.status != "waiting":
        raise HTTPException(status.HTTP_409_CONFLICT, "すでに相手が参加しています")
    return CreateSessionResponse(sessionId=session.id, joinUrl=_new_join_url(session))


@router.post("/exchange/sessions/{session_id}/join")
async def join_session(session_id: str, body: JoinRequest, did: str = Depends(require_did)) -> SessionState:
    session = _get_session(session_id)
    if did == session.a:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "自分のセッションには参加できません")
    if session.b == did:
        return session.state()
    if session.b is not None or session.status != "waiting":
        raise HTTPException(status.HTTP_409_CONFLICT, "このセッションには参加できません")
    if session.join_tokens.get(body.t, 0) <= time.monotonic():
        raise HTTPException(status.HTTP_410_GONE, "QR の有効期限が切れています。読み直してください")
    try:
        ok = await pds.check_no_block(session.a, did, fresh=True)
    except pds.PdsError as e:
        logger.warning("session %s: block check failed on join: a=%s b=%s: %s", session.id, session.a, did, e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "ブロックの確認ができませんでした") from e
    if not ok:
        logger.info("session %s: join refused (block): a=%s b=%s", session.id, session.a, did)
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この相手とは交換できません")
    # ブロックを確かめている間に別の人が参加していないか
    if session.b is not None or session.status != "waiting":
        raise HTTPException(status.HTTP_409_CONFLICT, "このセッションには参加できません")
    session.b = did
    session.status = "selecting"
    session.join_tokens.clear()
    return session.state()


@router.websocket("/exchange/sessions/{session_id}/ws")
async def exchange_ws(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    did = await authenticate_websocket(websocket)
    if did is None:
        return
    session = _sessions.get(session_id)
    if session is None or did not in session.members():
        await websocket.close(code=4403, reason="forbidden")
        return
    old = session.sockets.get(did)
    session.sockets[did] = websocket
    if old is not None:
        try:
            await old.close()
        except Exception:
            pass

    # 相手が先に選んでいたら、つないだときに伝える
    partner = session.partner_of(did)
    if partner and partner in session.selected:
        await _send(session, did, PartnerSelectedMessage(type="partner_selected", sticker=session.selected[partner]))
    if session.status == "confirmed":
        await _send(session, did, BothConfirmedMessage(type="both_confirmed", occasion=session.occasion))

    try:
        while True:
            try:
                message = _client_message.validate_python(await websocket.receive_json())
            except (ValidationError, ValueError) as e:
                logger.info("ws %s: invalid message from %s: %s", session.id, did, e)
                continue
            await _handle_message(session, did, message)
    except WebSocketDisconnect:
        pass
    finally:
        if session.sockets.get(did) is websocket:
            session.sockets.pop(did, None)


async def _handle_message(session: Session, did: str, message) -> None:
    if session.status not in ("waiting", "selecting"):
        return
    partner = session.partner_of(did)
    if isinstance(message, SelectMessage):
        if did in session.confirmed:
            return  # 確定したあとは変えられない
        changed = session.selected.get(did) != message.sticker
        session.selected[did] = message.sticker
        # 相手が確定したあとに選び直したら、相手の確定を取り消す（見せた1枚をすり替えて成立させないため）。
        # 相手の画面は partner_selected で選び直しを知り、確定し直してもらう
        if partner and changed:
            session.confirmed.discard(partner)
        if partner:
            await _send(session, partner, PartnerSelectedMessage(type="partner_selected", sticker=message.sticker))
    elif isinstance(message, ConfirmMessage):
        if did not in session.selected:
            return
        session.confirmed.add(did)
        if session.b and session.confirmed == {session.a, session.b}:
            session.status = "confirmed"
            for member in session.members():
                await _send(session, member, BothConfirmedMessage(type="both_confirmed", occasion=session.occasion))


@router.post("/exchange/sessions/{session_id}/commit")
async def commit(session_id: str, body: CommitRequest, did: str = Depends(require_did)) -> CommitResponse:
    session = _get_session(session_id)
    if did not in session.members():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "このセッションの参加者ではありません")
    if session.status == "completed":
        return CommitResponse(result="completed")
    if session.status != "confirmed":
        raise HTTPException(status.HTTP_409_CONFLICT, "まだ2人の確定がそろっていません")
    try:
        uri_did, collection, _ = pds.parse_at_uri(body.uri)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    if uri_did != did or collection != EXCHANGE_COLLECTION:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "自分の PDS の exchange レコードではありません")

    async with session.lock:
        if session.status == "completed":
            return CommitResponse(result="completed")
        session.commits[did] = body.uri
        if len(session.commits) < 2:
            return CommitResponse(result="waiting_partner")
        try:
            views, reason = await _verify(session)
        except pds.PdsError as e:
            logger.warning("session %s: verify failed: %s", session.id, e)
            return CommitResponse(result="failed", reason="相手の PDS が読めませんでした。もう一度送ってください")
        if views is None:
            logger.info("session %s failed: %s (commits=%s)", session.id, reason, session.commits)
            return CommitResponse(result="failed", reason=reason)

        session.status = "completed"
        for member, view in views.items():
            await _send(session, member, CompletedMessage(type="completed", exchange=view))
        logger.info("session %s completed", session.id)
        return CommitResponse(result="completed")


def _same_ref(x: dict, y: dict) -> bool:
    return isinstance(x, dict) and isinstance(y, dict) and x.get("uri") == y.get("uri") and x.get("cid") == y.get("cid")


async def _verify(session: Session) -> tuple[dict[str, ExchangeView] | None, str | None]:
    """spec 6章の成立条件1〜6。通れば2人それぞれから見た交換、通らなければ理由を返す。"""
    a, b = session.a, session.b
    records = {}
    for did in (a, b):
        record = await pds.get_record(session.commits[did])
        if record is None:
            return None, "交換の記録が PDS にありません"
        records[did] = record["value"]
    va, vb = records[a], records[b]

    # 1. 同じ sessionId
    if va.get("sessionId") != session.id or vb.get("sessionId") != session.id:
        return None, "sessionId が一致しません"
    # 2. partner が相手
    if va.get("partner") != b or vb.get("partner") != a:
        return None, "partner が相手の DID ではありません"
    # 3. 渡したものと受け取ったものが対応する
    if not _same_ref(va.get("gave"), vb.get("received")) or not _same_ref(vb.get("gave"), va.get("received")):
        return None, "渡したステッカーと受け取ったステッカーが対応しません"
    # 4. gave が本人の PDS にある本人のステッカー
    for did, value in records.items():
        gave = value["gave"]
        try:
            gave_did, collection, _ = pds.parse_at_uri(gave["uri"])
        except ValueError:
            return None, "渡したステッカーの URI が正しくありません"
        if gave_did != did or collection != STICKER_COLLECTION:
            return None, "渡したステッカーが本人のものではありません"
        sticker = await pds.get_record(gave["uri"])
        if sticker is None or sticker.get("cid") != gave.get("cid"):
            return None, "渡したステッカーが PDS にありません"
    # 5. ブロックが無い
    if not await pds.check_no_block(a, b, fresh=True):
        return None, "この相手とは交換できません"
    # 6. occasion がセッションの値と同じ（入力が無いときは2人とも空）
    if (va.get("occasion") or None) != session.occasion or (vb.get("occasion") or None) != session.occasion:
        return None, "場面がセッションの値と一致しません"

    views = {
        did: ExchangeView(
            sessionId=session.id,
            occasion=session.occasion,
            partner=value["partner"],
            gave=StrongRef(**value["gave"]),
            received=StrongRef(**value["received"]),
            createdAt=value.get("createdAt", ""),
        )
        for did, value in records.items()
    }
    return views, None
