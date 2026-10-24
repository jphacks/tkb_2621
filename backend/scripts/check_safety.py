"""「安心」の要件（spec 3章 #8・#10・#11）を、本番のサーバーで通しで確かめる。

PDS に書くのはこのスクリプトだけ（サーバー本体は読むだけ）。テスト用の2アカウントで:
  1. 交換を1回通して completed になる
  2. #10 A がステッカーを削除すると、B の /timeline から消える（テスト用に1枚作って消す）
  3. #11 A が B をブロックすると join が 403、B の /timeline に A が出ない。最後にブロックを外す
  4. #8 位置情報付きの JPEG を /cutout に送ると、返る PNG にメタデータが無い

アカウントは fake_exchange.py と同じ（FAKE_A_*, FAKE_B_*。リポジトリ直下の .env も読む）。

使い方（backend/ で）:
  .venv/Scripts/python scripts/check_safety.py --target prod
  .venv/Scripts/python scripts/check_safety.py --target prod --photo 写真.jpg
"""

import argparse
import asyncio
import base64
import io
import struct
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from PIL import Image, ImageDraw, ImageFilter

from fake_exchange import TARGETS, Failed, User, check, connect_users, exchange, start_session

# サーバーは相手ごとに30秒キャッシュするので、それより少し長く待つ
POLL_SECONDS = 45
POLL_INTERVAL = 5

# PNG で画素の表示に要るチャンク。これ以外（eXIf, tEXt, iTXt, zTXt, tIME, iCCP, pHYs など）があれば NG
ALLOWED_CHUNKS = {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"}
# JPEG の EXIF に埋める目印。返ってきた PNG にこの文字列が残っていたら NG
MARKER = "PIKKLES-CHECK-SAFETY-GPS"

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'OK' if ok else 'NG'}: {name}{f' — {detail}' if detail else ''}")


def timeline(http: httpx.Client, user: User) -> list[dict]:
    return check(http.get("/timeline", params={"limit": 100}, headers=user.headers()))["items"]


def poll(http: httpx.Client, user: User, condition, label: str) -> bool:
    """condition(items) が真になるまで /timeline を読み直す。POLL_SECONDS で諦める。"""
    deadline = time.monotonic() + POLL_SECONDS
    while True:
        items = timeline(http, user)
        if condition(items):
            return True
        if time.monotonic() >= deadline:
            return False
        print(f"  …{label}を待っています（{len(items)} 件）")
        time.sleep(POLL_INTERVAL)


async def check_exchange(http: httpx.Client, base_url: str, a: User, b: User) -> None:
    try:
        session_id = await exchange(http, base_url, a, b, "check_safety テスト")
        record("交換が completed になる", True, session_id)
    except Failed as e:
        record("交換が completed になる", False, str(e))


def check_delete(http: httpx.Client, a: User, b: User) -> None:
    """#10。消すのはテスト用に作った1枚だけ（交換したステッカーは消さない）。"""
    sticker = a.create_sticker("check_safety 削除テスト")
    deleted = False
    try:
        if not poll(http, b, lambda items: any(i["uri"] == sticker["uri"] for i in items), "B のタイムラインに出るの"):
            record("#10 削除したステッカーがタイムラインから消える", False, "削除前に B のタイムラインに出ませんでした")
            return
        a.delete_record(sticker["uri"])
        deleted = True
        gone = poll(http, b, lambda items: all(i["uri"] != sticker["uri"] for i in items), "消えるの")
        record("#10 削除したステッカーがタイムラインから消える", gone, "" if gone else f"{POLL_SECONDS}秒たっても残っています")
    finally:
        if not deleted:
            a.delete_record(sticker["uri"])


def check_block(http: httpx.Client, a: User, b: User) -> None:
    """#11。ブロックは何があっても最後に外す。"""
    block_uri = a.block(b.did)
    try:
        # ブロックした直後でも参加できないこと（サーバーのキャッシュで素通りしない）
        session_id, t = start_session(http, a, None)
        res = http.post(f"/exchange/sessions/{session_id}/join", json={"t": t}, headers=b.headers())
        record("#11 ブロック中は join が 403", res.status_code == 403, f"{res.status_code} {res.text[:200]}")

        hidden = poll(http, b, lambda items: all(i["author"] != a.did for i in items), "A が消えるの")
        record("#11 ブロック中は B のタイムラインに A が出ない", hidden, "" if hidden else f"{POLL_SECONDS}秒たっても出ています")
    finally:
        a.delete_record(block_uri)

    # 外したことの確かめ。テストのアカウントが次から交換できなくなっていないか
    session_id, t = start_session(http, a, None)
    res = http.post(f"/exchange/sessions/{session_id}/join", json={"t": t}, headers=b.headers())
    record("#11 ブロックを外すと join できる", res.status_code == 200, f"{res.status_code} {res.text[:200]}")


def gps_jpeg(photo: Path | None) -> bytes:
    """位置情報（GPS）と目印入りの EXIF を付けた JPEG。photo が無ければ、白地に赤い丸を描いて作る。"""
    if photo:
        image = Image.open(photo).convert("RGB")
    else:
        image = Image.new("RGB", (800, 600), (235, 235, 230))
        draw = ImageDraw.Draw(image)
        draw.ellipse((250, 150, 550, 450), fill=(220, 40, 40))
        draw.ellipse((320, 200, 400, 280), fill=(250, 140, 140))
        image = image.filter(ImageFilter.GaussianBlur(1))

    exif = Image.Exif()
    exif[0x010E] = MARKER  # ImageDescription
    exif[0x0110] = MARKER  # Model
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"  # GPSLatitudeRef
    gps[2] = (35.0, 41.0, 22.0)  # GPSLatitude
    gps[3] = "E"
    gps[4] = (139.0, 41.0, 30.0)
    buf = io.BytesIO()
    image.save(buf, "JPEG", exif=exif, quality=90, comment=MARKER.encode())
    data = buf.getvalue()
    # 送る前に、本当に GPS が入っていることを確かめる（入っていなければこの確認は意味が無い）
    if 0x8825 not in Image.open(io.BytesIO(data)).getexif():
        raise RuntimeError("テスト用の JPEG に GPS を付けられませんでした")
    return data


def png_chunks(data: bytes) -> list[bytes]:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("PNG ではありません")
    chunks, pos = [], 8
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        chunks.append(kind)
        pos += 12 + length
    return chunks


def check_cutout(http: httpx.Client, a: User, photo: Path | None) -> None:
    """#8"""
    name = "#8 /cutout の PNG にメタデータが無い"
    res = http.post(
        "/cutout",
        files={"image": ("gps.jpg", gps_jpeg(photo), "image/jpeg")},
        data={"source": "photo"},
        headers=a.headers(),
    )
    if res.status_code != 200:
        hint = "（合成画像で被写体が見つからなければ --photo で写真を渡してください）" if res.status_code == 400 else ""
        record(name, False, f"/cutout が {res.status_code} {res.text[:200]}{hint}")
        return
    png = base64.b64decode(res.json()["image"])
    chunks = png_chunks(png)
    extra = sorted({c.decode() for c in chunks} - {c.decode() for c in ALLOWED_CHUNKS})
    problems = []
    if extra:
        problems.append(f"余計なチャンク {extra}")
    if MARKER.encode() in png:
        problems.append("EXIF の目印が残っています")
    image = Image.open(io.BytesIO(png))
    if len(image.getexif()):
        problems.append(f"EXIF が読めます {dict(image.getexif())}")
    record(name, not problems, "; ".join(problems) or f"チャンク {[c.decode() for c in dict.fromkeys(chunks)]}")


async def run(base_url: str, photo: Path | None) -> None:
    http, a, b = connect_users(base_url)
    health = check(http.get("/health"))
    print(f"backend version {health.get('version', '（version がありません）')}")

    steps = [
        ("交換が completed になる", lambda: check_exchange(http, base_url, a, b)),
        ("#10 削除したステッカーがタイムラインから消える", lambda: check_delete(http, a, b)),
        ("#11 ブロック", lambda: check_block(http, a, b)),
        ("#8 /cutout の PNG にメタデータが無い", lambda: check_cutout(http, a, photo)),
    ]
    for name, step in steps:
        print(f"\n== {name}")
        try:
            result = step()
            if asyncio.iscoroutine(result):
                await result
        except Exception as e:  # 1つ落ちても残りは流す
            record(name, False, f"{type(e).__name__}: {e}")

    print(f"\n== 結果（{base_url} version {health.get('version')}）")
    for name, ok, detail in results:
        print(f"{'OK' if ok else 'NG'}  {name}{f'  ({detail})' if detail and not ok else ''}")
    if not all(ok for _, ok, _ in results):
        sys.exit(1)


def main() -> None:
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", choices=TARGETS, default="local")
    parser.add_argument("--url", help="接続先を直接指定する（--target より優先）")
    parser.add_argument("--photo", type=Path, help="#8 で送る写真（無ければ合成画像を使う）")
    args = parser.parse_args()
    asyncio.run(run((args.url or TARGETS[args.target]).rstrip("/"), args.photo))


if __name__ == "__main__":
    main()
