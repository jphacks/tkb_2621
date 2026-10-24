"""環境変数の読み込み。値は .env.example の名前で Render やシェルに入れる。"""

import os
import subprocess
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent

# 例：did:web:xxxx.onrender.com。getServiceAuth の aud と一致させる
BACKEND_DID = os.getenv("BACKEND_DID", "")

# Render Postgres の接続先。無ければ共同フィールドのメンバーをメモリに持つ（手元の開発用）
DATABASE_URL = os.getenv("DATABASE_URL", "")

# 本番は https://pikkles.kosora623.com。手元の Vite も許可する
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "")
ALLOWED_ORIGINS = [o for o in (FRONTEND_ORIGIN, "http://127.0.0.1:5173") if o]
# 交換の QR に載せる参加URLの頭
JOIN_URL_BASE = (FRONTEND_ORIGIN or "https://pikkles.kosora623.com").rstrip("/")

# rembg のモデルの置き場所。ビルド時に落としたものを実行時にも使うため、ホームではなく backend/ の中に置く
U2NET_HOME = os.getenv("U2NET_HOME") or str(BACKEND_DIR / "models")
os.environ["U2NET_HOME"] = U2NET_HOME


def _git_commit() -> str:
    # Render はビルドしたコミットを RENDER_GIT_COMMIT に入れる。手元では git から読む
    commit = os.getenv("RENDER_GIT_COMMIT")
    if commit:
        return commit
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=BACKEND_DIR, capture_output=True, text=True, timeout=5, check=True
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return "unknown"


# /health で返す。本番に出ているコミットを確かめるため
GIT_COMMIT = _git_commit()
