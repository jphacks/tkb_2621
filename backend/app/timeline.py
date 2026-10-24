"""タイムライン（spec 7章）。相手の PDS を直接読む。

交換の相手は PDS から集める（Render は寝るとメモリが消えるため）。共同フィールドのメンバーは fields.py の DB から。
"""

import asyncio
import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status

from . import fields, pds
from .auth import require_did
from .exchange import EXCHANGE_COLLECTION, STICKER_COLLECTION
from .schemas import TimelineItem, TimelineResponse

logger = logging.getLogger(__name__)

router = APIRouter()

CACHE_SECONDS = 30
# 期限切れのキャッシュを掃除し始める件数
CACHE_SWEEP_SIZE = 1000

_cache: dict[tuple[str, str], tuple[float, list[dict] | pds.PdsError]] = {}


async def _records(did: str, collection: str) -> list[dict]:
    """listRecords の結果。相手・コレクションごとに30秒キャッシュする。

    読めなかったことも30秒覚えておく（落ちている PDS のタイムアウトを毎回待たないため）。
    """
    key = (did, collection)
    now = time.monotonic()
    cached = _cache.get(key)
    if cached is None or now - cached[0] >= CACHE_SECONDS:
        try:
            result = [r for r in await pds.list_records(did, collection) if isinstance(r.get("value"), dict)]
        except pds.PdsError as e:
            result = e
        if len(_cache) >= CACHE_SWEEP_SIZE:
            for k in [k for k, (t, _) in _cache.items() if now - t >= CACHE_SECONDS]:
                del _cache[k]
        cached = _cache[key] = (now, result)
    if isinstance(cached[1], pds.PdsError):
        raise cached[1]
    return cached[1]


async def _has_pair(owner: str, partner: str, session_ids: set[str]) -> bool:
    """partner の PDS に、owner を相手とする同じ sessionId の exchange があれば True。"""
    for r in await _records(partner, EXCHANGE_COLLECTION):
        if r["value"].get("partner") == owner and r["value"].get("sessionId") in session_ids:
            return True
    return False


def _sessions_by_partner(owner: str, records: list[dict]) -> dict[str, set[str]]:
    by_partner: dict[str, set[str]] = {}
    for r in records:
        partner, session_id = r["value"].get("partner"), r["value"].get("sessionId")
        if isinstance(partner, str) and partner.startswith("did:") and partner != owner and isinstance(session_id, str):
            by_partner.setdefault(partner, set()).add(session_id)
    return by_partner


async def _exchange_partners(did: str) -> set[str]:
    """成立した交換の相手。自分の exchange の partner のうち、相手の PDS にも同じ sessionId があるもの。"""
    by_partner = _sessions_by_partner(did, await _records(did, EXCHANGE_COLLECTION))

    async def established(partner: str) -> bool:
        try:
            return await _has_pair(did, partner, by_partner[partner])
        except pds.PdsError as e:
            logger.warning("timeline: partner check failed: %s", e)
            return False

    results = await asyncio.gather(*(established(p) for p in by_partner))
    return {p for p, ok in zip(by_partner, results) if ok}


async def collect_partners(did: str) -> set[str]:
    """タイムラインに出す相手（成立した交換の相手と、同じ共同フィールドのメンバー）。ブロック関係にある相手は外す。"""
    candidates = await _exchange_partners(did)
    try:
        candidates |= await fields.co_members(did)
    except fields.StoreUnavailable:
        # DB が落ちていても、交換の相手だけで返す
        logger.exception("timeline: field members failed")

    async def not_blocked(partner: str) -> bool:
        try:
            return await pds.check_no_block(did, partner)
        except pds.PdsError as e:
            # 確かめられない相手は出さない
            logger.warning("timeline: block check failed: %s", e)
            return False

    results = await asyncio.gather(*(not_blocked(p) for p in candidates))
    return {p for p, ok in zip(candidates, results) if ok}


def _parse_time(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        t = datetime.fromisoformat(value)
    except ValueError:
        return None
    return t.replace(tzinfo=timezone.utc) if t.tzinfo is None else t.astimezone(timezone.utc)


def _item(kind: str, author: str, record: dict) -> tuple[datetime, TimelineItem] | None:
    created = _parse_time(record["value"].get("createdAt"))
    if created is None or not isinstance(record.get("uri"), str) or not isinstance(record.get("cid"), str):
        return None
    item = TimelineItem(
        kind=kind,
        author=author,
        uri=record["uri"],
        cid=record["cid"],
        record=record["value"],
        createdAt=record["value"]["createdAt"],
    )
    return created, item


async def _partner_items(partner: str) -> list[tuple[datetime, TimelineItem]]:
    """相手1人の sticker と、成立した exchange。PDS が読めなければその人は飛ばす。"""
    try:
        stickers, exchanges = await asyncio.gather(
            _records(partner, STICKER_COLLECTION), _records(partner, EXCHANGE_COLLECTION)
        )
    except pds.PdsError as e:
        logger.warning("timeline: skip %s: %s", partner, e)
        return []

    items = [i for r in stickers if (i := _item("sticker", partner, r))]
    # 交換は成立したものだけ（第三者の PDS にも対になる記録があるもの）
    by_other = _sessions_by_partner(partner, exchanges)

    async def established(other: str) -> bool:
        try:
            return await _has_pair(partner, other, by_other[other])
        except pds.PdsError:
            return False

    results = await asyncio.gather(*(established(o) for o in by_other))
    ok_others = {o for o, ok in zip(by_other, results) if ok}
    for r in exchanges:
        if r["value"].get("partner") in ok_others and (i := _item("exchange", partner, r)):
            items.append(i)
    return items


def _encode_cursor(created: datetime, uri: str) -> str:
    return f"{created.isoformat()}|{uri}"


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    created, sep, uri = cursor.partition("|")
    t = _parse_time(created)
    if not sep or t is None or not uri:
        raise ValueError(cursor)
    return t, uri


@router.get("/timeline")
async def timeline(
    cursor: str | None = Query(default=None),
    limit: int = Query(default=30, ge=1, le=100),
    did: str = Depends(require_did),
) -> TimelineResponse:
    after = None
    if cursor:
        try:
            after = _decode_cursor(cursor)
        except ValueError as e:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "cursor が正しくありません") from e
    try:
        partners = await collect_partners(did)
    except pds.PdsError as e:
        logger.warning("timeline: own PDS failed: %s", e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "自分の PDS が読めませんでした") from e

    items = [i for chunk in await asyncio.gather(*(_partner_items(p) for p in partners)) for i in chunk]
    # 新しい順。同じ時刻は uri で並びを決める
    items.sort(key=lambda x: (x[0], x[1].uri), reverse=True)
    if after is not None:
        items = [x for x in items if (x[0], x[1].uri) < after]

    page = items[:limit]
    next_cursor = _encode_cursor(page[-1][0], page[-1][1].uri) if len(items) > limit else None
    return TimelineResponse(items=[x[1] for x in page], cursor=next_cursor)
