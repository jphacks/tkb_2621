"""他人の PDS を読むだけの部品。書き込みはしない（AGENTS.md）。"""

import asyncio
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
# 同じ人のブロックを同時に読みに行かないように、読んでいる途中のものを覚えておく
_block_inflight: dict[str, asyncio.Task] = {}

# PDS への接続を使い回す。毎回つなぎ直すと、TLS のやり取りだけで1回の読み込みに往復が数回増える
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS)
    return _client


async def close() -> None:
    """lifespan の終わりに呼ぶ"""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


class PdsError(Exception):
    """PDS や DID 文書が読めない"""


def _describe(e: Exception) -> str:
    """ログで原因がわかるように、例外の型と中身を短く書く（タイムアウトは str が空になる）"""
    return f"{type(e).__name__}: {e}" if str(e) else type(e).__name__


def _error_code(res: httpx.Response) -> str:
    """XRPC のエラー応答 {"error": …, "message": …} から原因を取り出す。JSON でなければ本文の頭。"""
    try:
        body = res.json()
    except ValueError:
        return res.text[:200]
    if isinstance(body, dict):
        return f"{body.get('error')}: {body.get('message')}"
    return str(body)[:200]


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
        raise PdsError(f"DID 文書が読めません: {did}: {_describe(e)}") from e
    endpoint = doc.get_pds_endpoint()
    if not endpoint:
        raise PdsError(f"PDS の場所がありません: {did}")
    return endpoint.rstrip("/")


async def _xrpc_get(did: str, method: str, params: dict) -> httpx.Response:
    endpoint = await get_pds_endpoint(did)
    try:
        return await _http().get(f"{endpoint}/xrpc/{method}", params=params)
    except httpx.HTTPError as e:
        raise PdsError(f"{method} に失敗しました: {did} {endpoint}: {_describe(e)}") from e


async def get_record(uri: str) -> dict | None:
    """レコードを本人の PDS から読む。{"uri", "cid", "value"} を返す。無ければ None。"""
    did, collection, rkey = parse_at_uri(uri)
    res = await _xrpc_get(
        did, "com.atproto.repo.getRecord", {"repo": did, "collection": collection, "rkey": rkey}
    )
    if res.status_code == 400 and _error_code(res).startswith("RecordNotFound"):
        return None
    if res.status_code != 200:
        raise PdsError(f"getRecord が {res.status_code} を返しました: {uri}: {_error_code(res)}")
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
            raise PdsError(
                f"listRecords が {res.status_code} を返しました: {did} {collection}: {_error_code(res)}"
            )
        body = res.json()
        records.extend(body.get("records", []))
        cursor = body.get("cursor")
        if not cursor or not body.get("records"):
            break
    else:
        logger.warning("listRecords がページ数の上限に達しました: %s %s", did, collection)
    return records


async def _read_blocks(did: str) -> set[str]:
    records = await list_records(did, "app.bsky.graph.block")
    subjects = {r["value"].get("subject") for r in records if isinstance(r.get("value"), dict)}
    subjects.discard(None)
    _block_cache[did] = (time.monotonic(), subjects)
    return subjects


async def blocked_dids(did: str, fresh: bool = False) -> set[str]:
    """did がブロックしている相手の DID。30秒キャッシュする。fresh なら読み直す。"""
    if fresh:
        return await _read_blocks(did)
    cached = _block_cache.get(did)
    if cached and time.monotonic() - cached[0] < BLOCK_CACHE_SECONDS:
        return cached[1]
    task = _block_inflight.get(did)
    if task is None:
        task = _block_inflight[did] = asyncio.ensure_future(_read_blocks(did))
        task.add_done_callback(lambda _: _block_inflight.pop(did, None))
    # 待っている1人が取り消されても、ほかの人の読み込みは止めない
    return await asyncio.shield(task)


async def check_no_block(a: str, b: str, fresh: bool = False) -> bool:
    """2人の間にどちら向きにもブロックが無ければ True（spec 6章の成立条件5）。

    交換の参加と成立では fresh にする。キャッシュのままだと、ブロックした直後の30秒は交換できてしまう。
    """
    blocked_by_a, blocked_by_b = await asyncio.gather(blocked_dids(a, fresh), blocked_dids(b, fresh))
    return b not in blocked_by_a and a not in blocked_by_b
