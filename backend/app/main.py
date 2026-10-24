import logging
from contextlib import asynccontextmanager
from urllib.parse import unquote

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware

from . import cutout as cutout_service
from .auth import require_did
from .exchange import router as exchange_router
from .config import ALLOWED_ORIGINS, BACKEND_DID
from .schemas import CutoutResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    cutout_service.init_session()
    yield


app = FastAPI(title="Pikkles API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(exchange_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
def cutout(image: UploadFile = File(...)) -> CutoutResponse:
    try:
        return cutout_service.cutout(image.file.read())
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
