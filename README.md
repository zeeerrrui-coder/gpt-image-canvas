# GPT Image Canvas

Local professional AI canvas built with tldraw, Hono, SQLite, and GPT Image 2.

## Requirements

- Node.js 22 or newer.
- pnpm 9.14.2. The package manager is pinned in `package.json`; Corepack can activate it with `corepack prepare pnpm@9.14.2 --activate`.
- Docker Desktop or a compatible Docker Engine for the Docker workflow.
- An OpenAI-compatible Images API key that supports `gpt-image-2` for live generation. The app can boot without credentials, but generation requests will return a runtime missing-key error.

## Quick Start

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

Set `OPENAI_API_KEY` in `.env` before live generation. Keep `OPENAI_BASE_URL=https://api.openai.com/v1` for OpenAI, or replace it with an OpenAI-compatible base URL. The only supported image model is `gpt-image-2`.

Open the web app at `http://localhost:5173`.

## Development Workflow

`pnpm dev` starts both services:

- API: Hono on `http://127.0.0.1:8787` by default.
- Web: Vite on `http://localhost:5173`, proxying `/api` to the API service.

Use the right-side AI panel to enter a prompt, choose a scene size, and generate. When one image shape is selected on the canvas, the generate button switches to reference-image generation. The canvas autosaves to the local API after edits, and recent generation history provides locate, rerun, and download actions for stored outputs.

Before completing changes, run:

```powershell
pnpm typecheck
pnpm build
```

## Scripts

- `pnpm dev` starts both workspace development workflows.
- `pnpm api:dev` starts the API development workflow.
- `pnpm web:dev` starts the web development workflow.
- `pnpm typecheck` checks shared, web, and API TypeScript.
- `pnpm build` builds shared, web, and API packages.
- `pnpm start` starts the built API package.

## Docker

Docker Compose builds the shared contracts, web app, and API into one image. The Hono API serves both `/api` and the built web bundle from a single localhost port, while SQLite data and generated assets persist in host `./data`.

```powershell
Copy-Item .env.example .env
docker compose config --quiet --no-env-resolution
docker compose up --build
```

Open the app at `http://localhost:8787` by default. Set `PORT` in `.env` before starting Docker Compose to use a different localhost port.

`OPENAI_API_KEY` may be left empty for local boot checks. The app still starts, and generation endpoints return a missing-key JSON error until credentials are configured.

## Local Data

Runtime state is stored under `DATA_DIR`, which defaults to `./data` locally and `/app/data` in Docker. The directory contains:

- `gpt-image-canvas.sqlite` for the default project, generation history, and asset metadata.
- `assets/` for generated image files.

The Docker Compose workflow bind-mounts host `./data` to `/app/data`, so projects and generated assets survive container rebuilds. Do not commit `.env`, `data/`, generated images, SQLite files, or build output.

## Troubleshooting

- Missing or empty `OPENAI_API_KEY`: the app still boots; text-to-image and reference-image requests return a missing-key JSON error. Add a valid key to `.env` and restart the API or Docker container.
- Unsupported provider capability: confirm the configured provider supports OpenAI-compatible `/images/generations` and `/images/edits` requests with `gpt-image-2`.
- Port already in use: set `PORT` in `.env` for the API/Docker runtime, or run Vite on another port when prompted.
- Docker build cannot pull `node:22-bookworm-slim`: verify Docker is running and Docker Hub is reachable, then rerun `docker compose up --build`.
- Docker config output includes `.env` values by default. Use `docker compose config --quiet --no-env-resolution` for validation when real credentials are present, and do not share expanded config output.
- Stale or unwanted local state: stop the app and remove files under `data/`. This deletes local project state, history, and generated assets.

## Ralph

Ralph templates live in `.agents/ralph`, and the executable PRD is `.agents/tasks/prd-gpt-image-canvas.json`.
