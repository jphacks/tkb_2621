"""spec 8章のサービス認証。getServiceAuth の JWT を検証して、呼び出した人の DID を返す。"""

import logging

from atproto_core.exceptions import AtProtocolError
from atproto_identity.cache.in_memory_cache import AsyncDidInMemoryCache
from atproto_identity.resolver import AsyncIdResolver
from atproto_server.auth.jwt import verify_jwt_async
from fastapi import Header, HTTPException, WebSocket, status
from pydantic import ValidationError

from .config import BACKEND_DID
from .schemas import AuthMessage

logger = logging.getLogger(__name__)

_resolver = AsyncIdResolver(cache=AsyncDidInMemoryCache())


class AuthError(Exception):
    pass


async def _get_signing_key(did: str, force_refresh: bool) -> str:
    # iss の DID 文書から署名鍵を引く
    return await _resolver.did.resolve_atproto_key(did, force_refresh)


async def verify_token(token: str) -> str:
    """JWT の署名・aud・有効期限を確かめ、iss（呼び出した人の DID）を返す。"""
    if not BACKEND_DID:
        # aud を確かめられないまま通さない
        raise RuntimeError("BACKEND_DID が設定されていません")
    try:
        payload = await verify_jwt_async(token, _get_signing_key, own_did=BACKEND_DID)
    except AtProtocolError as e:
        raise AuthError(str(e) or type(e).__name__) from e
    # verify_jwt_async は exp が無いと期限を確かめないので、ここで必須にする
    if payload.exp is None:
        raise AuthError("exp がありません")
    return payload.iss


async def require_did(authorization: str = Header(default="")) -> str:
    """Depends 用。Authorization: Bearer <JWT> を検証し、通れば DID を返す。通らなければ 401。"""
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Authorization: Bearer <token> が必要です",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        return await verify_token(token.strip())
    except AuthError as e:
        logger.info("auth failed: %s", e)
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "認証に失敗しました", headers={"WWW-Authenticate": "Bearer"}
        ) from e


async def authenticate_websocket(websocket: WebSocket) -> str | None:
    """accept 済みの WebSocket で最初のメッセージ {"type":"auth","token":"…"} を検証する。

    通れば DID を返す。通らなければ 4401 で閉じて None を返す。
    """
    try:
        message = AuthMessage.model_validate(await websocket.receive_json())
        return await verify_token(message.token)
    except (ValidationError, ValueError, AuthError) as e:
        logger.info("ws auth failed: %s", e)
        await websocket.close(code=4401, reason="unauthorized")
        return None
