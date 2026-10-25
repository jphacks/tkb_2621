"""テスト用の交換クライアント。2つの Bluesky アカウントで交換を1回通す。

PDS に書くのはこのスクリプトだけ（サーバー本体は読むだけ）。
アカウントは環境変数（リポジトリ直下の .env も読む）から:
  FAKE_A_HANDLE, FAKE_A_APP_PASSWORD, FAKE_B_HANDLE, FAKE_B_APP_PASSWORD

使い方（backend/ で）:
  .venv/Scripts/python scripts/fake_exchange.py --target local
  .venv/Scripts/python scripts/fake_exchange.py --target prod
"""

import argparse
import asyncio
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
from atproto import Client
from dotenv import load_dotenv
from PIL import Image
from websockets.asyncio.client import connect

TARGETS = {
    "local": "http://127.0.0.1:8000",
    "prod": "https://pikkles-api.onrender.com",
}
STICKER = "com.kosora623.pikkles.sticker"
EXCHANGE = "com.kosora623.pikkles.exchange"
BLOCK = "app.bsky.graph.block"


class Failed(Exception):
    """サーバーの応答が想定と違う"""


class User:
    def __init__(self, name: str, handle: str, password: str, backend_did: str) -> None:
        self.name = name
        self.client = Client()
        self.client.login(handle, password)
        self.did = self.client.me.did
        self.backend_did = backend_did
        print(f"[{name}] login {handle} ({self.did})")

    def token(self) -> str:
        # getServiceAuth の JWT は60秒で切れるので、使うたびに取り直す
        return self.client.com.atproto.server.get_service_auth({"aud": self.backend_did}).token

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token()}"}

    def latest_sticker(self) -> dict:
        """PDS にある最新のステッカー。無ければ小さな PNG で1件作る。"""
        res = self.client.com.atproto.repo.list_records({"repo": self.did, "collection": STICKER, "limit": 1})
        if res.records:
            print(f"[{self.name}] sticker {res.records[0].uri}")
            return {"uri": res.records[0].uri, "cid": res.records[0].cid}
        return self.create_sticker("fake_exchange のテスト")

    def create_sticker(self, caption: str) -> dict:
        """小さな PNG でステッカーを1件作り、strongRef を返す。"""
        buf = io.BytesIO()
        Image.new("RGBA", (64, 64), (255, 120, 0, 255) if self.name == "A" else (0, 120, 255, 255)).save(buf, "PNG")
        blob = self.client.com.atproto.repo.upload_blob(buf.getvalue()).blob
        record = {
            "$type": STICKER,
            "image": {"$type": "blob", "ref": {"$link": blob.ref.link}, "mimeType": blob.mime_type, "size": blob.size},
            "width": 64,
            "height": 64,
            "source": "illustration",
            "caption": caption,
            "createdAt": now(),
        }
        res = self.client.com.atproto.repo.create_record({"repo": self.did, "collection": STICKER, "record": record})
        print(f"[{self.name}] created sticker {res.uri}")
        return {"uri": res.uri, "cid": res.cid}

    def write_exchange(self, session_id: str, occasion: str | None, partner: str, gave: dict, received: dict) -> str:
        record = {
            "$type": EXCHANGE,
            "sessionId": session_id,
            "partner": partner,
            "gave": gave,
            "received": received,
            "createdAt": now(),
        }
        if occasion:
            record["occasion"] = occasion
        res = self.client.com.atproto.repo.create_record({"repo": self.did, "collection": EXCHANGE, "record": record})
        print(f"[{self.name}] wrote exchange {res.uri}")
        return res.uri

    def block(self, subject: str) -> str:
        """Bluesky で subject をブロックする（app.bsky.graph.block を書く）。レコードの URI を返す。"""
        record = {"$type": BLOCK, "subject": subject, "createdAt": now()}
        res = self.client.com.atproto.repo.create_record({"repo": self.did, "collection": BLOCK, "record": record})
        print(f"[{self.name}] blocked {subject} ({res.uri})")
        return res.uri

    def delete_record(self, uri: str) -> None:
        _, collection, rkey = uri.removeprefix("at://").split("/")
        self.client.com.atproto.repo.delete_record({"repo": self.did, "collection": collection, "rkey": rkey})
        print(f"[{self.name}] deleted {uri}")


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def check(res: httpx.Response) -> dict:
    if res.status_code >= 400:
        raise Failed(f"{res.request.method} {res.request.url} -> {res.status_code} {res.text}")
    return res.json()


async def wait_for(ws, name: str, type_: str) -> dict:
    while True:
        message = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
        print(f"[{name}] <- {message}")
        if message["type"] == "cancelled":
            raise Failed(f"cancelled: {message.get('reason')}")
        if message["type"] == type_:
            return message


def connect_users(base_url: str) -> tuple[httpx.Client, User, User]:
    """バックエンドの DID を引き、.env の2アカウントでログインする。"""
    http = httpx.Client(base_url=base_url, timeout=60)  # Render の無料枠は起動に数十秒かかる
    backend_did = check(http.get("/.well-known/did.json"))["id"]
    print(f"backend {base_url} ({backend_did})")
    a = User("A", os.environ["FAKE_A_HANDLE"], os.environ["FAKE_A_APP_PASSWORD"], backend_did)
    b = User("B", os.environ["FAKE_B_HANDLE"], os.environ["FAKE_B_APP_PASSWORD"], backend_did)
    return http, a, b


def start_session(http: httpx.Client, a: User, occasion: str | None) -> tuple[str, str]:
    """A がセッションを始める。sessionId と QR の合言葉 t を返す。"""
    created = check(http.post("/exchange/sessions", json={"occasion": occasion}, headers=a.headers()))
    print(f"[A] session {created['sessionId']} {created['joinUrl']}")
    return created["sessionId"], parse_qs(urlparse(created["joinUrl"]).query)["t"][0]


async def exchange(http: httpx.Client, base_url: str, a: User, b: User, occasion: str | None) -> str:
    """交換を1回通す。成立すれば sessionId を返し、しなければ Failed。"""
    sticker_a, sticker_b = a.latest_sticker(), b.latest_sticker()

    session_id, t = start_session(http, a, occasion)
    state = check(http.post(f"/exchange/sessions/{session_id}/join", json={"t": t}, headers=b.headers()))
    print(f"[B] joined {state}")

    ws_url = base_url.replace("http", "ws", 1) + f"/exchange/sessions/{session_id}/ws"
    async with connect(ws_url) as ws_a, connect(ws_url) as ws_b:
        await ws_a.send(json.dumps({"type": "auth", "token": a.token()}))
        await ws_b.send(json.dumps({"type": "auth", "token": b.token()}))
        await ws_a.send(json.dumps({"type": "select", "sticker": sticker_a}))
        await ws_b.send(json.dumps({"type": "select", "sticker": sticker_b}))
        await wait_for(ws_a, "A", "partner_selected")
        await wait_for(ws_b, "B", "partner_selected")
        await ws_a.send(json.dumps({"type": "confirm"}))
        await ws_b.send(json.dumps({"type": "confirm"}))
        confirmed = await wait_for(ws_a, "A", "both_confirmed")
        await wait_for(ws_b, "B", "both_confirmed")

        # occasion はサーバーが持つ値をそのまま入れる
        occ = confirmed.get("occasion")
        uri_a = a.write_exchange(session_id, occ, b.did, sticker_a, sticker_b)
        uri_b = b.write_exchange(session_id, occ, a.did, sticker_b, sticker_a)

        result_a = check(http.post(f"/exchange/sessions/{session_id}/commit", json={"uri": uri_a}, headers=a.headers()))
        print(f"[A] commit {result_a}")
        result_b = check(http.post(f"/exchange/sessions/{session_id}/commit", json={"uri": uri_b}, headers=b.headers()))
        print(f"[B] commit {result_b}")
        if result_b["result"] != "completed":
            raise Failed(f"交換が成立しませんでした: {result_b}")
        await wait_for(ws_a, "A", "completed")
        await wait_for(ws_b, "B", "completed")

    return session_id


async def run(base_url: str, occasion: str | None) -> None:
    http, a, b = connect_users(base_url)
    try:
        await exchange(http, base_url, a, b, occasion)
    except Failed as e:
        sys.exit(str(e))
    print("OK: completed")


def main() -> None:
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", choices=TARGETS, default="local")
    parser.add_argument("--url", help="接続先を直接指定する（--target より優先）")
    parser.add_argument("--occasion", default="fake_exchange テスト")
    args = parser.parse_args()
    asyncio.run(run((args.url or TARGETS[args.target]).rstrip("/"), args.occasion or None))


if __name__ == "__main__":
    main()
