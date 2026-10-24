"""他人の PDS を読むだけの部品。書き込みはしない（AGENTS.md）。"""

import logging
import time

import httpx
from atproto_core.exceptions import AtProtocolError
from atproto_identity.cache.in_memory_cache import AsyncDidInMemoryCache
from atproto_identity.resolver import AsyncIdResolver

logger = logging.getLogger(__name__)

_resolver = AsyncIdResolver(cache=AsyncDidInMemoryCache())

TIMEOUT_SECONDS = 10
BLOCK_CACHE_SECONDS = 30
# ブロックが極端に多い人で止まらないように、読むページ数に上限を付ける（100件×50ページ）
MAX_PAGES = 50

_block_cache: dict[str, tuple[float, set[str]]] = {}


class PdsError(Exception):
    """PDS や DID 文書が読めない"""


def parse_at_uri(uri: str) -> tuple[str, str, str]:
    """at://<did>/<collection>/<rkey> を分ける。形が違えば ValueError。"""
    if not uri.startswith("at://"):
        raise ValueError(f"at:// URI ではありません: {uri}")
    parts = uri.removeprefix("at://").split("/")
    if len(parts) != 3 or not parts[0].startswith("did:") or not all(parts):
        raise ValueError(f"at://<did>/<collection>/<rkey> の形ではありません: {uri}")
    return parts[0], parts[1], parts[2]


async def get_pds_endpoint(did: str) -> str:
    try:
        doc = await _resolver.did.ensure_resolve(did)
    except AtProtocolError as e:
        raise PdsError(f"DID 文書が読めません: {did}") from e
    endpoint = doc.get_pds_endpoint()
    if not endpoint:
        raise PdsError(f"PDS の場所がありません: {did}")
    return endpoint.rstrip("/")


async def _xrpc_get(did: str, method: str, params: dict) -> httpx.Response:
    endpoint = await get_pds_endpoint(did)
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            return await client.get(f"{endpoint}/xrpc/{method}", params=params)
    except httpx.HTTPError as e:
        raise PdsError(f"{method} に失敗しました: {did}") from e


async def get_record(uri: str) -> dict | None:
    """レコードを本人の PDS から読む。{"uri", "cid", "value"} を返す。無ければ None。"""
    did, collection, rkey = parse_at_uri(uri)
    res = await _xrpc_get(
        did, "com.atproto.repo.getRecord", {"repo": did, "collection": collection, "rkey": rkey}
    )
    if res.status_code == 400 and res.json().get("error") == "RecordNotFound":
        return None
    if res.status_code != 200:
        raise PdsError(f"getRecord が {res.status_code} を返しました: {uri}")
    return res.json()


async def list_records(did: str, collection: str) -> list[dict]:
    """コレクションのレコードを全ページ読む。"""
    records: list[dict] = []
    cursor = None
    for _ in range(MAX_PAGES):
        params = {"repo": did, "collection": collection, "limit": 100}
        if cursor:
            params["cursor"] = cursor
        res = await _xrpc_get(did, "com.atproto.repo.listRecords", params)
        if res.status_code != 200:
            raise PdsError(f"listRecords が {res.status_code} を返しました: {did} {collection}")
        body = res.json()
        records.extend(body.get("records", []))
        cursor = body.get("cursor")
        if not cursor or not body.get("records"):
            break
    else:
        logger.warning("listRecords がページ数の上限に達しました: %s %s", did, collection)
    return records


async def blocked_dids(did: str) -> set[str]:
    """did がブロックしている相手の DID。30秒キャッシュする。"""
    cached = _block_cache.get(did)
    if cached and time.monotonic() - cached[0] < BLOCK_CACHE_SECONDS:
        return cached[1]
    records = await list_records(did, "app.bsky.graph.block")
    subjects = {r["value"].get("subject") for r in records if isinstance(r.get("value"), dict)}
    subjects.discard(None)
    _block_cache[did] = (time.monotonic(), subjects)
    return subjects


async def check_no_block(a: str, b: str) -> bool:
    """2人の間にどちら向きにもブロックが無ければ True（spec 6章の成立条件5）。"""
    return b not in await blocked_dids(a) and a not in await blocked_dids(b)
