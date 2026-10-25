"""切り抜き・白フチ・影。写真は u2netp で背景を消し、イラストは元の透過をそのまま使う。"""

import base64
import io
import logging
import threading
import time
from typing import Literal

import cv2
import numpy as np
import onnxruntime as ort
import psutil
from PIL import ExifTags, Image, ImageOps
from rembg import remove
from rembg.sessions.base import BaseSession
from rembg.sessions.u2netp import U2netpSession

from .schemas import CutoutResponse

logger = logging.getLogger(__name__)

CutoutSource = Literal["photo", "illustration"]

MAX_SIDE = 1024
MAX_BYTES = 1_000_000  # sticker.image の maxSize
# 1MB を超えたら長辺をこの割合で縮めて作り直す
SHRINK = 0.8
MAX_RETRIES = 3
# 縮小前の画素数の上限。大きな透過PNGは展開だけで数百MBになり、Render の 512MB を超える
MAX_PIXELS = 30_000_000

BORDER_RATIO = 0.03  # 白フチの太さ（長辺に対する割合）
SHADOW_BLUR_RATIO = 0.015  # 影のぼかし（ガウスの σ）
SHADOW_OFFSET_RATIO = 0.01  # 影を下にずらす量
SHADOW_OPACITY = 0.3
# これ以上の不透明度を「被写体」とみなす。rembg の縁の薄いノイズにはフチを付けない
ALPHA_THRESHOLD = 128

_session: BaseSession | None = None
# 同時に走るとメモリのピークが重なって512MBを超えるので、1枚ずつ処理する
_lock = threading.Lock()
_process = psutil.Process()


class OutputTooLargeError(Exception):
    """縮めて作り直しても 1MB に収まらない。"""


def _rss_mb() -> float:
    return _process.memory_info().rss / 1024 / 1024


def _peak_mb() -> float:
    """プロセス起動からの最大メモリ。Render（Linux）では ru_maxrss、Windows では peak_wset。"""
    peak = getattr(_process.memory_info(), "peak_wset", None)
    if peak is not None:
        return peak / 1024 / 1024
    try:
        import resource
    except ImportError:
        return float("nan")
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


def init_session() -> None:
    """起動時に1回だけ呼ぶ。モデルはビルド時にダウンロード済みのものを使う。"""
    global _session
    start = time.perf_counter()
    # onnxruntime のメモリアリーナを切る。既定のままだと推論のたびに確保した領域を抱え続け、
    # 手元の計測で 650MB まで増えた（切ると常駐 180MB 前後、ピーク 420MB 前後）
    opts = ort.SessionOptions()
    opts.enable_cpu_mem_arena = False
    opts.enable_mem_pattern = False
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    _session = U2netpSession(U2netpSession.name(), opts)
    logger.info("rembg session ready: model=u2netp %.2fs rss=%.0fMB", time.perf_counter() - start, _rss_mb())


def _encode_png(image: Image.Image) -> bytes:
    # 新しい Image から保存するので EXIF などのメタデータは付かない
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def cutout(data: bytes, source: CutoutSource = "photo") -> CutoutResponse:
    """切り抜き・白フチ・影を付け、メタデータの無い透過PNGで返す。

    読めない画像・透過の無いイラスト・被写体が無い写真は ValueError。
    縮めても 1MB に収まらなければ OutputTooLargeError。
    """
    if _session is None:
        raise RuntimeError("rembg のセッションが作られていません")
    with _lock:
        return _cutout(data, source, _session)


def _load(data: bytes, mode: str) -> Image.Image:
    """EXIF の向きを画素に反映し、長辺 MAX_SIDE に縮めた画像を返す。"""
    try:
        with Image.open(io.BytesIO(data)) as src:
            # JPEG は縮小しながら読み込んで、大きな写真でもメモリを抑える（JPEG 以外では何もしない）
            src.draft("RGB", (MAX_SIDE, MAX_SIDE))
            if src.width * src.height > MAX_PIXELS:
                raise ValueError("画像が大きすぎます")
            # 先に長辺 MAX_SIDE まで縮め、大きな画像の複製を作らない（25MP の透過PNGでピークが約95MB減る）。
            # パレット画像は縮めると色が崩れ、形式の変換や EXIF の回転と順番を入れ替えると結果が変わるので、そのときは後で縮める
            if src.mode == mode and src.getexif().get(ExifTags.Base.Orientation, 1) == 1:
                src.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
            # EXIF の向きを画素に反映してから、EXIF ごと捨てる
            image = ImageOps.exif_transpose(src).convert(mode)
    except (OSError, Image.DecompressionBombError) as e:
        raise ValueError("画像として読めません") from e
    image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
    return image


def _cutout(data: bytes, source: CutoutSource, session: BaseSession) -> CutoutResponse:
    start = time.perf_counter()
    rss_before = _rss_mb()

    if source == "illustration":
        cut = _load(data, "RGBA")
        if cut.getchannel("A").getextrema()[0] == 255:
            raise ValueError("透過のある画像（透過PNGなど）を選んでください")
    else:
        cut = remove(_load(data, "RGB"), session=session).convert("RGBA")
    if cut.getchannel("A").getextrema()[1] < ALPHA_THRESHOLD:
        raise ValueError("被写体が見つかりません")
    inference_s = time.perf_counter() - start

    # 1MB を超えたら、切り抜いた画像を縮めてから白フチと影を付け直す
    base = cut
    for attempt in range(MAX_RETRIES + 1):
        if attempt:
            base = cut.resize(
                (max(1, round(cut.width * SHRINK**attempt)), max(1, round(cut.height * SHRINK**attempt))),
                Image.Resampling.LANCZOS,
            )
        sticker = _decorate(base)
        png = _encode_png(sticker)
        if len(png) <= MAX_BYTES:
            break
    else:
        raise OutputTooLargeError(f"{MAX_RETRIES}回縮めても {len(png)}B で 1MB に収まりません")

    logger.info(
        "cutout: source=%s %dx%d %dB retries=%d %.2fs (cut %.2fs) rss=%.0fMB (before %.0fMB) peak=%.0fMB",
        source,
        sticker.width,
        sticker.height,
        len(png),
        attempt,
        time.perf_counter() - start,
        inference_s,
        _rss_mb(),
        rss_before,
        _peak_mb(),
    )
    return CutoutResponse(image=base64.b64encode(png).decode("ascii"), width=sticker.width, height=sticker.height)


def _decorate(cut: Image.Image) -> Image.Image:
    """透過画像に白フチと柔らかい影を付け、余白を切り詰めて返す。"""
    side = max(cut.size)
    border = max(2, round(side * BORDER_RATIO))
    blur = max(1.0, side * SHADOW_BLUR_RATIO)
    offset = max(1, round(side * SHADOW_OFFSET_RATIO))
    # フチと影がはみ出さないよう、先にキャンバスを広げる（ガウスは 3σ でほぼ 0 になる）
    pad = border + offset + int(blur * 3) + 2

    alpha = np.pad(np.asarray(cut.getchannel("A")), pad)
    mask = np.where(alpha >= ALPHA_THRESHOLD, 255, 0).astype(np.uint8)
    # 切り抜きの小さなゴミにフチが付いて白い点にならないよう、先に取り除く
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    outline = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * border + 1, 2 * border + 1)))
    # フチの外周のギザギザをならす
    outline = cv2.GaussianBlur(outline, (0, 0), 1.0)

    shadow = np.zeros_like(outline)
    shadow[offset:] = cv2.GaussianBlur(outline, (0, 0), blur)[:-offset]
    shadow = (shadow * SHADOW_OPACITY).astype(np.uint8)

    size = (cut.width + 2 * pad, cut.height + 2 * pad)
    black = Image.new("L", size, 0)
    white = Image.new("L", size, 255)
    canvas = Image.merge("RGBA", (black, black, black, Image.fromarray(shadow)))
    canvas.alpha_composite(Image.merge("RGBA", (white, white, white, Image.fromarray(outline))))
    canvas.alpha_composite(cut, (pad, pad))

    # 影の薄い裾まで含めて、見える部分だけに切り詰める
    bbox = canvas.getchannel("A").point(lambda v: 255 if v > 4 else 0).getbbox()
    return canvas.crop(bbox) if bbox else canvas
