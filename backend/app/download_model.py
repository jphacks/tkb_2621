"""ビルド時に rembg のモデル（u2netp）をダウンロードする。

Render の Build: pip install -r requirements.txt && python -m app.download_model
"""

from rembg.sessions.u2netp import U2netpSession

from .config import U2NET_HOME

if __name__ == "__main__":
    U2netpSession.download_models()
    print(f"downloaded u2netp to {U2NET_HOME}")
