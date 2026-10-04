# Vercel deployment

This project deploys the Vite frontend and FastAPI backend together:

- Static frontend: `dist/`
- Python function: `api/index.py`
- API routes: `/api/backends` and `/api/complete`

## Deploy

From this directory:

```powershell
npm install
npm run build
vercel login
vercel link
vercel --prod
```

Vercel builds the frontend through `@vercel/static-build` and runs FastAPI through `@vercel/python`.

## Environment variables

Add these in the Vercel project settings or with `vercel env add`:

```text
BACKEND=modal
VITE_BACKEND=modal
VITE_API_URL=
VITE_API_local=http://127.0.0.1:3020
VITE_API_modal=
LOCAL_LLM_URL=http://127.0.0.1:8000/v1/chat/completions
LOCAL_LLM_MODEL=Qwen/Qwen3.5-9B
LOCAL_LLM_KEY=
MODAL_LLM_URL=https://your-modal-endpoint/v1/chat/completions
MODAL_LLM_MODEL=Qwen/Qwen3.5-9B
MODAL_LLM_KEY=your-modal-token
FRONTEND_ORIGINS=https://your-project.vercel.app
```

`MODAL_LLM_KEY` is server-only. Do not prefix it with `VITE_`.

For a same-project deployment, leave `VITE_API_URL` empty so the browser uses same-origin `/api` routes. For a separate API project, set `VITE_API_URL` to its public Vercel URL and set `FRONTEND_ORIGINS` on the API project to the frontend URL.

For local development, `.env` is loaded by the Python server and Vite loads `VITE_*` values at build/dev startup. Restart both processes after changing environment variables.
