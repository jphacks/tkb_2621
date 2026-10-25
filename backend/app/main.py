import logging
from contextlib import asynccontextmanager
from urllib.parse import unquote

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import cutout as cutout_service
from . import fields
from .auth import require_did
from .exchange import router as exchange_router
from .config import ALLOWED_ORIGINS, BACKEND_DID, GIT_COMMIT
from .schemas import CutoutResponse
from .timeline import router as timeline_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    logger.info("starting: version=%s backend_did=%s", GIT_COMMIT, BACKEND_DID or "(unset)")
    cutout_service.init_session()
    await fields.store.init()
    yield
    await fields.store.close()


app = FastAPI(title="Pikkles API", lifespan=lifespan)


@app.middleware("http")
async def log_unhandled(request: Request, call_next):
    """処理されなかった例外を、どのリクエストで起きたかと一緒にログに出す（Render のログで追えるように）。

    CORS より内側に置くので、500 にも CORS ヘッダーが付き、ブラウザ側でも中身が読める。
    """
    try:
        return await call_next(request)
    except Exception:
        logger.exception("unhandled error: %s %s", request.method, request.url.path)
        return JSONResponse({"detail": "サーバーでエラーが起きました"}, status_code=500)


# add_middleware は外側に積むので、上の log_unhandled より後に足す
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(exchange_router)
app.include_router(timeline_router)
app.include_router(fields.router)


@app.get("/health")
def health() -> dict[str, str]:
    # version は本番に出ているコミット（Render の RENDER_GIT_COMMIT）
    return {"status": "ok", "version": GIT_COMMIT}


@app.get("/.well-known/did.json")
def did_document() -> dict:
    """自分の did:web を公開する。getServiceAuth の aud はこの DID。"""
    if not BACKEND_DID.startswith("did:web:"):
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "BACKEND_DID が did:web ではありません")
    # did:web ではポートの「:」が %3A に符号化されている
    host = unquote(BACKEND_DID.removeprefix("did:web:"))
    return {
        "@context": ["https://www.w3.org/ns/did/v1"],
        "id": BACKEND_DID,
        "service": [
            {
                "id": "#pikkles",
                "type": "PikklesBackend",
                "serviceEndpoint": f"https://{host}",
            }
        ],
    }


@app.get("/me")
def me(did: str = Depends(require_did)) -> dict[str, str]:
    """認証の確認用。"""
    return {"did": did}


@app.post("/cutout")
def cutout(
    image: UploadFile = File(...),
    source: cutout_service.CutoutSource = Form("photo"),
    did: str = Depends(require_did),
) -> CutoutResponse:
    logger.info("cutout requested: did=%s source=%s", did, source)
    # 上限を1バイト超えるところまでしか読まない（大きなファイルを丸ごとメモリに載せない）
    data = image.file.read(cutout_service.MAX_UPLOAD_BYTES + 1)
    if len(data) > cutout_service.MAX_UPLOAD_BYTES:
        logger.info("cutout rejected: did=%s source=%s: upload too large", did, source)
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "画像が大きすぎます（20MB まで）")
    try:
        return cutout_service.cutout(data, source)
    except ValueError as e:
        logger.info("cutout rejected: did=%s source=%s: %s", did, source, e)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    except cutout_service.OutputTooLargeError as e:
        logger.warning("cutout too large: did=%s source=%s: %s", did, source, e)
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "画像を 1MB に収められませんでした") from e
