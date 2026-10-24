# 起動方法

- frontend：`cd frontend && npm install && npm run dev`（http://localhost:5173）
- backend：`cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt && .venv/Scripts/uvicorn app.main:app --reload`（http://localhost:8000/health。macOS/Linux は `.venv/bin/`）
- Render：Root Directory `backend`、Build `pip install -r requirements.txt`、Start `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

環境変数は `.env.example` を `.env` にコピーして値を入れる（`.env` はコミットしない）。
