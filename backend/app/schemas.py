"""spec 8章の API と WebSocket メッセージの形（下書き）。処理はサーバー担当が書く。

JSON のキー名はフロントと揃えて camelCase のまま使う。
認証は Authorization: Bearer <getServiceAuth の JWT>（WebSocket は AuthMessage）。
"""

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field

# 場面は任意、最大50文字。入力が無いときは None（2人の記録とも空）
Occasion = Annotated[Optional[str], Field(default=None, max_length=50)]


class StrongRef(BaseModel):
    """com.atproto.repo.strongRef"""

    uri: str
    cid: str


# ---- POST /cutout ----
# 入力は multipart の画像1枚。
# 出力の PNG は 1MB（sticker.image の maxSize）に収めるため、長辺を1024pxに縮めてから
# 切り抜き・白フチ・影を付け、EXIF などのメタデータを残さず再エンコードする。


class CutoutResponse(BaseModel):
    image: str  # base64 の透過PNG
    width: int
    height: int


# ---- POST /exchange/sessions ----


class CreateSessionRequest(BaseModel):
    occasion: Occasion


class CreateSessionResponse(BaseModel):
    sessionId: str
    joinUrl: str  # QR 用の参加URL（60秒で失効）


# ---- POST /exchange/sessions/{id}/join ----

class JoinRequest(BaseModel):
    t: str  # joinUrl の合言葉（60秒で失効）


SessionStatus = Literal["waiting", "selecting", "confirmed", "completed", "cancelled"]


class SessionState(BaseModel):
    sessionId: str
    occasion: Occasion
    status: SessionStatus


# ---- POST /exchange/sessions/{id}/commit ----


class CommitRequest(BaseModel):
    uri: str  # 自分の PDS に書いた exchange レコードの at:// URI


class CommitResponse(BaseModel):
    # completed: 成立 / waiting_partner: 相手の記録待ち / failed: 照合が通らない
    result: Literal["completed", "waiting_partner", "failed"]
    reason: Optional[str] = None


# ---- GET /exchanges?did= ----


class ExchangeView(BaseModel):
    """成立済みの交換1件"""

    sessionId: str
    occasion: Occasion
    partner: str  # DID
    gave: StrongRef
    received: StrongRef
    createdAt: str


class ExchangesResponse(BaseModel):
    exchanges: list[ExchangeView]


# ---- GET /timeline?cursor=&limit= ----


class TimelineItem(BaseModel):
    kind: Literal["sticker", "exchange"]
    author: str  # DID
    uri: str
    cid: str
    record: dict  # sticker または exchange のレコード本体
    createdAt: str


class TimelineResponse(BaseModel):
    items: list[TimelineItem]
    cursor: Optional[str] = None


# ---- WS /exchange/sessions/{id}/ws ----
# → クライアントから


class AuthMessage(BaseModel):
    """接続直後の最初のメッセージ"""

    type: Literal["auth"]
    token: str


class SelectMessage(BaseModel):
    type: Literal["select"]
    sticker: StrongRef


class ConfirmMessage(BaseModel):
    type: Literal["confirm"]


ClientMessage = Annotated[
    Union[AuthMessage, SelectMessage, ConfirmMessage], Field(discriminator="type")
]

# ← サーバーから


class PartnerSelectedMessage(BaseModel):
    type: Literal["partner_selected"]
    sticker: StrongRef


class BothConfirmedMessage(BaseModel):
    """両者確定。各自が自分の PDS に exchange を書く合図。occasion はこの値をそのまま入れる"""

    type: Literal["both_confirmed"]
    occasion: Occasion


class CompletedMessage(BaseModel):
    type: Literal["completed"]
    exchange: ExchangeView


class CancelledMessage(BaseModel):
    type: Literal["cancelled"]
    reason: str


ServerMessage = Annotated[
    Union[PartnerSelectedMessage, BothConfirmedMessage, CompletedMessage, CancelledMessage],
    Field(discriminator="type"),
]
