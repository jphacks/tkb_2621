"""背景除去。白フチと影はまだ付けない。"""

import base64
import io
import logging
import threading
import time

import onnxruntime as ort
import psutil
from PIL import Image, ImageOps
from rembg import remove
from rembg.sessions.base import BaseSession
from rembg.sessions.u2netp import U2netpSession

from .schemas import CutoutResponse

logger = logging.getLogger(__name__)

MAX_SIDE = 1024
MAX_BYTES = 1_000_000  # sticker.image の maxSize

_session: BaseSession | None = None
# 同時に走るとメモリのピークが重なって512MBを超えるので、1枚ずつ処理する
_lock = threading.Lock()
_process = psutil.Process()


def _rss_mb() -> float:
    return _process.memory_info().rss / 1024 / 1024


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


def cutout(data: bytes) -> CutoutResponse:
    """画像を長辺1024pxに縮めて背景を消し、メタデータの無い透過PNGで返す。

    読めない画像は ValueError。
    """
    if _session is None:
        raise RuntimeError("rembg のセッションが作られていません")
    with _lock:
        return _cutout(data, _session)


def _cutout(data: bytes, session: BaseSession) -> CutoutResponse:
    start = time.perf_counter()
    rss_before = _rss_mb()

    try:
        with Image.open(io.BytesIO(data)) as src:
            # JPEG は縮小しながら読み込んで、大きな写真でもメモリを抑える
            src.draft("RGB", (MAX_SIDE, MAX_SIDE))
            # EXIF の向きを画素に反映してから、EXIF ごと捨てる
            image = ImageOps.exif_transpose(src).convert("RGB")
    except (OSError, Image.DecompressionBombError) as e:
        raise ValueError("画像として読めません") from e
    image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)

    cut = remove(image, session=session).convert("RGBA")
    clean = Image.new("RGBA", cut.size)
    clean.paste(cut)

    png = _encode_png(clean)
    # 1MB を超えたら少しずつ縮めて収める
    while len(png) > MAX_BYTES:
        clean = clean.resize(
            (max(1, int(clean.width * 0.85)), max(1, int(clean.height * 0.85))), Image.Resampling.LANCZOS
        )
        png = _encode_png(clean)

    logger.info(
        "cutout: %dx%d %dB %.2fs rss=%.0fMB (before %.0fMB)",
        clean.width,
        clean.height,
        len(png),
        time.perf_counter() - start,
        _rss_mb(),
        rss_before,
    )
    return CutoutResponse(image=base64.b64encode(png).decode("ascii"), width=clean.width, height=clean.height)
