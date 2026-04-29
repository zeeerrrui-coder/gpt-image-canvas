# GPT Image Canvas

[English](README.md) | [简体中文](README.zh-CN.md)

Local professional AI canvas built with tldraw, Hono, SQLite, and GPT Image 2.

## Requirements

- Node.js 22 or newer.
- pnpm 9.14.2. The package manager is pinned in `package.json`; Corepack can activate it with `corepack prepare pnpm@9.14.2 --activate`.
- Docker Desktop or a compatible Docker Engine for the Docker workflow.
- An OpenAI API key with access to `gpt-image-2` for live generation. The app can boot without credentials, but generation requests will return a runtime missing-key error.

## Quick Start

Windows PowerShell:

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

macOS/Linux:

```sh
pnpm install
cp .env.example .env
pnpm dev
```

Set `OPENAI_API_KEY` in `.env` before live generation. The app uses the official OpenAI Image API with `gpt-image-2` by default. To route requests through an OpenAI-compatible endpoint, set `OPENAI_BASE_URL` in `.env`.

Open the web app at `http://localhost:5173`.

## Codex Users

Codex can work directly from this repository. After cloning, let it read `AGENTS.md`, then ask it to install dependencies and run checks with the pinned package manager:

```sh
pnpm install
pnpm typecheck
pnpm build
```

Keep credentials out of prompts and logs. Put your OpenAI API key only in a local `.env` file copied from `.env.example`, and do not paste the key into a Codex message. If Codex needs to verify live generation, ask it to use the existing `.env` without printing environment values.

For UI changes, have Codex run `pnpm dev` and verify the Vite app in a browser at `http://localhost:5173`. Local scratch files should stay under `.codex-temp/`, which is ignored by Git.

## Development Workflow

`pnpm dev` starts both services:

- API: Hono on `http://127.0.0.1:8787` by default.
- Web: Vite on `http://localhost:5173`, proxying `/api` to the API service.

Use the right-side AI panel to enter a prompt, choose a scene size, and generate. When one image shape is selected on the canvas, the generate button switches to reference-image generation. The canvas autosaves to the local API after edits, and recent generation history provides locate, rerun, and download actions for stored outputs.

Before completing changes, run:

```sh
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

Windows PowerShell:

```powershell
Copy-Item .env.example .env
docker compose config --quiet --no-env-resolution
docker compose up --build
```

macOS/Linux:

```sh
cp .env.example .env
docker compose config --quiet --no-env-resolution
docker compose up --build
```

Open the app at `http://localhost:8787` by default. Set `PORT` in `.env` before starting Docker Compose to use a different localhost port.

The Compose build accepts the same network-related build arguments used by the reference `open-managed-flow` project: `NODE_IMAGE`, `NPM_CONFIG_REGISTRY`, `APT_MIRROR`, and `APT_SECURITY_MIRROR`. The default `NODE_IMAGE` in Compose is `node:23-bullseye-slim` because it satisfies the app's `>=22` runtime requirement and is commonly available as a local cache when Docker Hub is unreachable. To force the exact Node 22 base image, run:

Windows PowerShell:

```powershell
$env:NODE_IMAGE = 'node:22-bookworm-slim'
docker compose up --build
```

macOS/Linux:

```sh
NODE_IMAGE=node:22-bookworm-slim docker compose up --build
```

`OPENAI_API_KEY` may be left empty for local boot checks. The app still starts, and generation endpoints return a missing-key JSON error until credentials are configured.

## Local Data

Runtime state is stored under `DATA_DIR`, which defaults to `./data` locally and `/app/data` in Docker. The directory contains:

- `gpt-image-canvas.sqlite` for the default project, generation history, and asset metadata.
- `assets/` for generated image files.

The Docker Compose workflow bind-mounts host `./data` to `/app/data`, so projects and generated assets survive container rebuilds. Do not commit `.env`, `data/`, generated images, SQLite files, or build output.

## Security / Privacy Notes

- Secrets are read only from `.env` or runtime environment variables. Never commit `.env`, expanded Docker Compose config output, shell history containing keys, or logs that include secret values.
- Prompts, project state, generated assets, and SQLite data are local runtime data under `DATA_DIR`. Treat `data/` as private unless you intentionally export specific assets.
- Before publishing a branch, check `git status --short` and confirm only source, docs, and intended metadata are staged. `.env`, `.ralph/`, `.codex-temp/`, `data/`, generated images, SQLite databases, and build output should stay untracked.
- If a real API key was ever committed, rotate that key first. Git ignore rules prevent future leaks, but they do not remove secrets from existing Git history.

## Troubleshooting

- Missing or empty `OPENAI_API_KEY`: the app still boots; text-to-image and reference-image requests return a missing-key JSON error. Add a valid key to `.env` and restart the API or Docker container.
- Custom provider endpoint: set `OPENAI_BASE_URL` in `.env`, for example `https://api.example.com/v1`, then restart the API or Docker container. The endpoint must be OpenAI-compatible and support the configured image model.
- Missing model access: confirm the OpenAI organization and project used by `OPENAI_API_KEY` can access `gpt-image-2`.
- High-resolution generation timeouts: upstream image requests default to 20 minutes; increase `OPENAI_IMAGE_TIMEOUT_MS` in `.env` if needed.
- Port already in use: set `PORT` in `.env` for the API/Docker runtime, or run Vite on another port when prompted.
- Docker build cannot pull the Node base image: use a locally cached image with `NODE_IMAGE=node:23-bullseye-slim docker compose up --build` on macOS/Linux or `$env:NODE_IMAGE = 'node:23-bullseye-slim'` followed by `docker compose up --build` in Windows PowerShell, or restore Docker Hub access and rerun `docker compose up --build`.
- Docker config output includes `.env` values by default. Use `docker compose config --quiet --no-env-resolution` for validation when real credentials are present, and do not share expanded config output.
- Stale or unwanted local state: stop the app and remove files under `data/`. This deletes local project state, history, and generated assets.

## License

MIT

## 友情链接

- [LINUX DO - 新的理想型社区](https://linux.do/)
