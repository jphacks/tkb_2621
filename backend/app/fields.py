"""共同フィールドのメンバー（spec 7章）。DATABASE_URL があれば Render Postgres、無ければメモリに持つ（手元の開発用）。"""

import asyncio
import logging
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from . import pds
from .auth import require_did
from .config import DATABASE_URL
from .schemas import StrongRef

logger = logging.getLogger(__name__)

router = APIRouter()

FIELD_COLLECTION = "com.kosora623.pikkles.field"
CONNECT_TIMEOUT_SECONDS = 10


class JoinFieldRequest(BaseModel):
    field: StrongRef


class FieldMembersResponse(BaseModel):
    members: list[str]  # DID。参加した順


class FieldStateResponse(FieldMembersResponse):
    closed: bool  # 閉じたフィールドにはもう参加できない


class _MemoryStore:
    def __init__(self) -> None:
        self._rows: dict[str, dict[str, datetime]] = {}  # field_uri → DID → joined_at
        self._closed: dict[str, datetime] = {}  # field_uri → closed_at

    async def init(self) -> None:
        logger.warning("DATABASE_URL が無いので、フィールドのメンバーはメモリに持ちます（再起動で消えます）")

    async def close(self) -> None:
        pass

    async def members(self, field_uri: str) -> list[str]:
        rows = self._rows.get(field_uri, {})
        return sorted(rows, key=lambda did: rows[did])

    async def add(self, field_uri: str, did: str) -> None:
        self._rows.setdefault(field_uri, {}).setdefault(did, datetime.now(timezone.utc))

    async def co_members(self, did: str) -> set[str]:
        return {m for rows in self._rows.values() if did in rows for m in rows if m != did}

    async def remove(self, field_uri: str, did: str) -> bool:
        """外したら True（もともとメンバーでなければ False）。"""
        rows = self._rows.get(field_uri, {})
        removed = rows.pop(did, None) is not None
        if not rows:
            self._rows.pop(field_uri, None)
        return removed

    async def remove_all(self, field_uri: str) -> None:
        self._rows.pop(field_uri, None)

    async def close_field(self, field_uri: str) -> None:
        self._closed.setdefault(field_uri, datetime.now(timezone.utc))

    async def is_closed(self, field_uri: str) -> bool:
        return field_uri in self._closed


class StoreUnavailable(Exception):
    """DB につながらない"""


_DB_ERRORS = (OSError, asyncpg.PostgresError, asyncpg.InterfaceError)


class _PostgresStore:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None
        self._connect_lock = asyncio.Lock()

    async def init(self) -> None:
        # つながらなくても起動は止めない（/cutout や交換まで落ちないように）。使うときにつなぎ直す
        try:
            await self._ensure_pool()
        except StoreUnavailable:
            logger.exception("Postgres につながりません")

    async def _ensure_pool(self) -> asyncpg.Pool:
        async with self._connect_lock:
            if self._pool is not None:
                return self._pool
            try:
                pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=5, timeout=CONNECT_TIMEOUT_SECONDS)
            except _DB_ERRORS as e:
                raise StoreUnavailable(str(e)) from e
            try:
                await self._create_table(pool)
            except _DB_ERRORS as e:
                await pool.close()
                raise StoreUnavailable(str(e)) from e
            self._pool = pool
            return pool

    async def _create_table(self, pool: asyncpg.Pool) -> None:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS field_members (
                    field_uri text NOT NULL,
                    did text NOT NULL,
                    joined_at timestamptz NOT NULL DEFAULT now(),
                    PRIMARY KEY (field_uri, did)
                );
                CREATE INDEX IF NOT EXISTS field_members_did ON field_members (did);
                CREATE TABLE IF NOT EXISTS closed_fields (
                    field_uri text PRIMARY KEY,
                    closed_at timestamptz NOT NULL DEFAULT now()
                );
                """
            )

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()

    async def _fetch(self, query: str, *args) -> list[asyncpg.Record]:
        pool = await self._ensure_pool()
        try:
            return await pool.fetch(query, *args)
        except _DB_ERRORS as e:
            raise StoreUnavailable(str(e)) from e

    async def members(self, field_uri: str) -> list[str]:
        rows = await self._fetch("SELECT did FROM field_members WHERE field_uri = $1 ORDER BY joined_at, did", field_uri)
        return [r["did"] for r in rows]

    async def add(self, field_uri: str, did: str) -> None:
        await self._fetch(
            "INSERT INTO field_members (field_uri, did) VALUES ($1, $2) ON CONFLICT DO NOTHING", field_uri, did
        )

    async def co_members(self, did: str) -> set[str]:
        rows = await self._fetch(
            """
            SELECT DISTINCT m.did FROM field_members m
            JOIN field_members me ON me.field_uri = m.field_uri
            WHERE me.did = $1 AND m.did <> $1
            """,
            did,
        )
        return {r["did"] for r in rows}

    async def remove(self, field_uri: str, did: str) -> bool:
        """外したら True（もともとメンバーでなければ False）。"""
        rows = await self._fetch(
            "DELETE FROM field_members WHERE field_uri = $1 AND did = $2 RETURNING did", field_uri, did
        )
        return bool(rows)

    async def remove_all(self, field_uri: str) -> None:
        await self._fetch("DELETE FROM field_members WHERE field_uri = $1", field_uri)

    async def close_field(self, field_uri: str) -> None:
        await self._fetch("INSERT INTO closed_fields (field_uri) VALUES ($1) ON CONFLICT DO NOTHING", field_uri)

    async def is_closed(self, field_uri: str) -> bool:
        rows = await self._fetch("SELECT 1 FROM closed_fields WHERE field_uri = $1", field_uri)
        return bool(rows)


store = _PostgresStore(DATABASE_URL) if DATABASE_URL else _MemoryStore()

# 2人が同時に参加して、互いのブロックの確認をすり抜けないように
_join_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


async def co_members(did: str) -> set[str]:
    """did が入っているフィールドの、did 以外のメンバー。"""
    return await store.co_members(did)


@asynccontextmanager
async def _unavailable_as_503():
    try:
        yield
    except StoreUnavailable as e:
        logger.warning("field store unavailable: %s", e)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "いまフィールドのメンバーを読めません") from e


def _field_creator(uri: str) -> str:
    try:
        creator, collection, _ = pds.parse_at_uri(uri)
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    if collection != FIELD_COLLECTION:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "共同フィールドの URI ではありません")
    return creator


@router.post("/fields/join")
async def join_field(body: JoinFieldRequest, did: str = Depends(require_did)) -> FieldMembersResponse:
    uri = body.field.uri
    creator = _field_creator(uri)
    async with _unavailable_as_503():
        if await store.is_closed(uri):
            raise HTTPException(status.HTTP_410_GONE, "このフィールドは閉じています")
    try:
        record = await pds.get_record(uri)
    except pds.PdsError as e:
        logger.warning("field check failed: %s", e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "フィールドを確かめられませんでした") from e
    if record is None or record.get("cid") != body.field.cid:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "フィールドが見つかりません")

    async with _join_locks[uri], _unavailable_as_503():
        # PDS を読んでいるあいだに閉じられたかもしれない
        if await store.is_closed(uri):
            raise HTTPException(status.HTTP_410_GONE, "このフィールドは閉じています")
        members = await store.members(uri)
        if did in members:
            return FieldMembersResponse(members=members)
        # 作った人もメンバーにする（作った人が先）
        others = [m for m in dict.fromkeys([creator, *members]) if m != did]
        try:
            results = await asyncio.gather(*(pds.check_no_block(did, m) for m in others))
        except pds.PdsError as e:
            logger.warning("block check failed: %s", e)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "ブロックの確認ができませんでした") from e
        if not all(results):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "このフィールドには参加できません")
        # 最初の参加のときだけ作った人を足す（抜けた作った人を、ほかの人の参加で戻さない）
        if not members:
            await store.add(uri, creator)
        await store.add(uri, did)
        return FieldMembersResponse(members=await store.members(uri))


@router.get("/fields/members")
async def field_members(uri: str = Query(...), did: str = Depends(require_did)) -> FieldStateResponse:
    _field_creator(uri)
    async with _unavailable_as_503():
        return FieldStateResponse(members=await store.members(uri), closed=await store.is_closed(uri))


@router.delete("/fields/members")
async def leave_field(uri: str = Query(...), did: str = Depends(require_did)) -> FieldStateResponse:
    """呼んだ人がフィールドから抜ける。メンバーでなくても 200。最後の1人が抜けたら閉じる。"""
    _field_creator(uri)
    async with _join_locks[uri], _unavailable_as_503():
        removed = await store.remove(uri, did)
        members = await store.members(uri)
        if removed and not members:
            await store.close_field(uri)
        return FieldStateResponse(members=members, closed=await store.is_closed(uri))


@router.delete("/fields")
async def delete_field(uri: str = Query(...), did: str = Depends(require_did)) -> dict[str, bool]:
    """作った人がフィールドを削除する。メンバーを全部外して閉じる。"""
    if _field_creator(uri) != did:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "フィールドを作った人だけが削除できます")
    async with _join_locks[uri], _unavailable_as_503():
        await store.remove_all(uri)
        await store.close_field(uri)
    return {"ok": True}
