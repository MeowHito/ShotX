# ShotX / EventDD Monorepo

AI-powered event photography platform scaffold.

## Structure

```text
frontend/   Next.js web app: landing, dashboard, guest, admin
backend/    NestJS API: auth, events, photos, guest, admin, local storage, BullMQ
worker/     Python FastAPI AI worker: InsightFace embedding endpoints
infra/      Local infra bootstrap files
```

## Required services

- Node.js 20+
- pnpm 9+
- Python 3.11+
- Docker Desktop
- Local or EC2 filesystem storage directory

## Environment setup

Copy examples before running:

```powershell
Copy-Item .env.example .env
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env.local
Copy-Item worker\.env.example worker\.env
```

Fill storage and secret values in `.env` and `backend/.env`. Do not commit real secrets.

## Install dependencies

```powershell
pnpm install
python -m venv worker\.venv
worker\.venv\Scripts\pip install -r worker\requirements.txt
```

For production AI, install GPU-compatible packages inside the worker environment:

```powershell
worker\.venv\Scripts\pip install insightface onnxruntime-gpu
```

Use `onnxruntime` instead of `onnxruntime-gpu` for CPU-only local testing.

## Start local infrastructure

```powershell
docker compose up -d
```

This starts:

- PostgreSQL 16 with pgvector on `localhost:5432`
- Redis on `localhost:6379`

## Database

```powershell
pnpm db:generate
pnpm db:migrate
```

## Run apps

Terminal 1:

```powershell
pnpm dev:backend
```

Terminal 2:

```powershell
pnpm dev:frontend
```

Terminal 3:

```powershell
worker\.venv\Scripts\python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --app-dir worker
```

## Local URLs

- Frontend: `http://localhost:3000`
- Backend health: `http://localhost:4000/api/v1/health`
- Worker health: `http://localhost:8000/health`

## Current implementation status

This scaffold includes real project structure and integration points, but AI/photo search is still a placeholder until the worker writes embeddings into PostgreSQL/pgvector and the backend search endpoint queries `photo_faces`.

Implemented foundation:

- Next.js routes: `/`, `/dashboard`, `/guest`, `/admin`
- NestJS modules: auth, events, photos, guest, watermark, admin, storage, queue
- Prisma schema for PostgreSQL + pgvector
- Local filesystem upload service for EC2
- BullMQ queue producer for photo AI jobs
- Python FastAPI worker with `/embed` and `/process-photo` endpoints

Next implementation tasks:

1. Add JWT guard role checks for admin routes.
2. Add thumbnail generation with `sharp` during upload.
3. Add BullMQ worker consumer that calls Python `/process-photo`.
4. Store face embeddings into `photo_faces` using raw SQL for pgvector.
5. Implement guest selfie vector search with cosine similarity.
6. Add signed/private original downloads and server-side watermarking.
