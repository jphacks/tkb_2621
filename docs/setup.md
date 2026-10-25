# 起動方法

- frontend：`cd frontend && npm install && npm run dev`（http://localhost:5173）
- backend：`cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && .venv/Scripts/python -m app.download_model && .venv/Scripts/uvicorn app.main:app --reload`（http://localhost:8000/health。macOS/Linux は `.venv/bin/`）
- Render：Root Directory `backend`、Build `pip install -r requirements.txt && python -m app.download_model`、Start `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

`app.download_model` は背景除去のモデル（u2netp）を `U2NET_HOME`（既定は `backend/models`）に落とす。

環境変数は `.env.example` を `.env` にコピーして値を入れる（`.env` はコミットしない）。`DATABASE_URL` が空なら、共同フィールドのメンバーはメモリに持つ（再起動で消える。手元の開発用）。

## 通しで確かめる

テスト用の2アカウント（`.env` の `FAKE_A_*`・`FAKE_B_*`、アプリパスワード）を使う。backend/ で：

- `.venv/Scripts/python scripts/fake_exchange.py --target local`（本番は `--target prod`）：交換を1回通す
- `.venv/Scripts/python scripts/check_safety.py --target prod`：削除・ブロック・位置情報の除去・共同フィールドの参加の決まりを通しで確かめる
