# GPT Image Canvas

[English](README.md) | [简体中文](README.zh-CN.md)

Controlled AI canvas built with tldraw, Hono, SQLite, and GPT Image 2. The current app includes username/password accounts, an administrator console, and credit limits: regular users register with 0 credits, administrators grant credits, each successful image costs 1 credit, and failed images do not deduct credits.

## Preview

![GPT Image Canvas preview](docs/assets/app-preview.png)

## Highlights

- AI canvas powered by tldraw with prompt-to-image and reference-image generation.
- Local-first storage for generated images and project snapshots.
- Optional Tencent Cloud COS backup for newly generated images.
- Generation history with locate, rerun, download, and cloud upload status.
- OpenAI-compatible image endpoint support, including PackyCode / `gpt-image` style responses.
- Username/password accounts, administrator credit management, and hidden provider settings for regular users.

## Requirements

- Node.js 22 or newer.
- pnpm 9.14.2. The package manager is pinned in `package.json`; Corepack can activate it with `corepack prepare pnpm@9.14.2 --activate`.
- Docker Desktop or a compatible Docker Engine for the Docker workflow.
- An OpenAI API key with access to `gpt-image-2`, or an administrator Codex login completed from the app, for live generation.
- Administrator bootstrap variables: `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

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

For API-key based live generation, set `OPENAI_API_KEY` in `.env` or open the top-right `配置` dialog in the app and save one local OpenAI-compatible API configuration. The app uses the official OpenAI Image API with `gpt-image-2` by default. To route requests through an OpenAI-compatible endpoint, set `OPENAI_BASE_URL` in `.env` or enter a local Base URL in the dialog; to use a different compatible image model, set `OPENAI_IMAGE_MODEL` or the dialog's advanced model field.

Before first deployment, set the administrator account in `.env`:

```sh
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
```

When no administrator exists and both values are set, the API creates that administrator on startup. Regular users can register themselves, but they start with 0 credits and need an administrator to grant credits before generation.

Open the web app at `http://localhost:5173`.

## Accounts, Credits, And Routes

- Logged-out visitors see the Chinese login/register screen instead of the old homepage.
- `/canvas` is the working canvas and the default signed-in route.
- `/gallery` is the gallery and only shows the signed-in user's own generated results.
- `/admin` is the administrator console for accounts and credits. It does not show other users' images, prompts, or canvas content.
- Regular users register with 0 credits and cannot generate until an administrator grants credits.
- Each successful image costs 1 credit. Total failures deduct 0 credits; partial success only deducts successful outputs.
- The top-right `配置` button is only visible to administrators. It shows provider priority and source details for environment OpenAI, local OpenAI-compatible API, and Codex.
- Provider priority defaults to environment OpenAI, local OpenAI, then Codex, and can be reordered in the dialog. Fallback only happens before a request is created when a higher-priority source is empty or unavailable.
- Environment values remain read-only. The dialog masks `OPENAI_API_KEY`, shows Base URL, model, timeout, and reminds you to restart the API after `.env` changes.
- The `Codex 登录` modal is only available to administrators, displays the verification URL and user code, and stores resulting OAuth token material only on the local API side.

## Provider Configuration

The provider configuration dialog saves only one local OpenAI-compatible API profile. Local API keys are stored in the SQLite database under `DATA_DIR`, returned only as masked values, and preserved unless you enter a replacement key. Only administrators can access provider, Codex, and COS settings.

Environment variables are still the most explicit operator-controlled source. They are visible as a read-only provider source in the dialog, are not edited by the app, and remain first in the default order. You can reorder sources in the UI, but do not expose the app publicly while `.env`, local provider keys, Codex tokens, or COS secrets are configured.

## Upgrading To v0.1.0

Back up local runtime data before upgrading:

Windows PowerShell:

```powershell
Copy-Item -Recurse data data-backup-before-v0.1.0
docker compose up --build
```

macOS/Linux:

```sh
cp -R data data-backup-before-v0.1.0
docker compose up --build
```

Make sure the web app and API are rebuilt together. If you use Docker, prefer `http://localhost:8787` and avoid running `pnpm dev` against the same `data/` directory at the same time.

## Codex Users

Codex can work directly from this repository. After cloning, let it read `AGENTS.md`, then ask it to install dependencies and run checks with the pinned package manager:

```sh
pnpm install
pnpm typecheck
pnpm build
```

Keep credentials out of prompts and logs. Put your OpenAI API key only in a local `.env` file copied from `.env.example` or the app's provider configuration dialog, and do not paste the key into a Codex message. If Codex needs to verify live generation, ask it to use existing local credentials without printing environment or SQLite values.

For UI changes, have Codex run `pnpm dev` and verify the Vite app in a browser at `http://localhost:5173`. Local scratch files should stay under `.codex-temp/`, which is ignored by Git.

## Development Workflow

`pnpm dev` starts both services:

- API: Hono on `http://127.0.0.1:8787` by default.
- Web: Vite on `http://localhost:5173`, proxying `/api` to the API service. The dev server uses a strict port so a stale app on `5173` cannot hide that this project failed to start.

Use the right-side AI panel to enter a prompt, choose a scene size, and generate. When one image shape is selected on the canvas, the generate button switches to reference-image generation. The canvas autosaves to the local API after edits, and recent generation history provides locate, rerun, and download actions for stored outputs.

The AI panel also includes a cloud storage button. Enable COS there when you want new generated images to be written locally and uploaded to COS.

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

Docker Compose also sets `SQLITE_JOURNAL_MODE=DELETE` and `SQLITE_LOCKING_MODE=EXCLUSIVE` by default. This avoids SQLite `SQLITE_IOERR_SHMOPEN` failures on bind-mounted `./data` directories in Docker Desktop while preserving projects and generated assets on the host.

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

`OPENAI_API_KEY` may be left empty for local boot checks, administrator-managed local provider configuration, or administrator Codex-login based generation. The app still starts; without any available provider, generation endpoints return a `missing_provider` JSON error and the browser shows the login/register screen.

## Tencent Cloud COS Backup

Generated images are always saved locally first. When COS is enabled from the in-app cloud storage dialog, new generated images are also uploaded to:

```text
<key-prefix>/YYYY/MM/<assetId>.<ext>
```

The default COS form values are read from `.env`:

- `COS_DEFAULT_BUCKET`
- `COS_DEFAULT_REGION`
- `COS_DEFAULT_KEY_PREFIX`

Saving COS settings performs a test upload and delete before persisting the configuration. `SecretKey` is stored in the local SQLite database because the app has no server-side account system yet, but GET responses only return a masked secret indicator.

Cloud upload failures do not fail image generation. The asset remains available locally, and the UI marks the history item with the cloud backup failure.

## Local Data

Runtime state is stored under `DATA_DIR`, which defaults to `./data` locally and `/app/data` in Docker. The directory contains:

- `gpt-image-canvas.sqlite` for the default project, generation history, asset metadata, cloud upload metadata, one optional local provider configuration, optional COS settings, and Codex OAuth token records.
- `assets/` for generated image files.

The Docker Compose workflow bind-mounts host `./data` to `/app/data`, so projects and generated assets survive container rebuilds. Do not commit `.env`, `data/`, generated images, SQLite files, or build output.

## Security / Privacy Notes

- Secrets are read only from `.env`, runtime environment variables, or the local SQLite settings database. Never commit `.env`, expanded Docker Compose config output, shell history containing keys, SQLite databases, or logs that include secret values.
- Local provider API keys saved from the top-right provider dialog are stored in SQLite and masked by the provider-config API. Treat `data/gpt-image-canvas.sqlite` as sensitive after saving a local API key, and do not publish the local app without adding your own authentication and network controls.
- Codex OAuth access tokens, refresh tokens, ID tokens, email, account ID, expiry, and refresh timestamps are stored in local SQLite under `DATA_DIR`. Treat the SQLite database as sensitive runtime data after Codex login.
- COS SecretKey values saved from the UI are stored locally in SQLite and are masked by the settings API. Treat `data/gpt-image-canvas.sqlite` as sensitive when COS is configured.
- Prompts, project state, generated assets, and SQLite data are local runtime data under `DATA_DIR`. Treat `data/` as private unless you intentionally export specific assets.
- Before publishing a branch, check `git status --short` and confirm only source, docs, and intended metadata are staged. `.env`, `.ralph/`, `.codex-temp/`, `data/`, generated images, SQLite databases, and build output should stay untracked.
- If a real API key was ever committed, rotate that key first. Git ignore rules prevent future leaks, but they do not remove secrets from existing Git history.

## Troubleshooting

- Missing or empty `OPENAI_API_KEY`: the app still boots. If no local API config or Codex session is available, text-to-image / reference-image requests return `missing_provider`. An administrator can add a valid key to `.env` and restart the API or Docker container, save a local API key from `配置`, or use the `Codex 登录` flow.
- Codex login cannot complete: confirm the machine can reach `https://auth.openai.com`, keep the device-login dialog open until authorization finishes, and restart the flow if the user code expires. Do not paste or log token values.
- Custom provider endpoint: set `OPENAI_BASE_URL` in `.env`, for example `https://api.example.com/v1`, then restart the API or Docker container, or enter a local Base URL in `配置`. The endpoint must be OpenAI-compatible and support the configured image model.
- Missing model access: confirm the OpenAI organization and project used by the active provider key can access the configured image model. Set `OPENAI_IMAGE_MODEL` or the local advanced model field if your compatible endpoint expects a different model name.
- High-resolution generation timeouts: upstream image requests default to 20 minutes; increase `OPENAI_IMAGE_TIMEOUT_MS` or the local provider timeout field if needed.
- Port already in use: set `PORT` in `.env` for the API/Docker runtime. If Web port `5173` is occupied, stop the process using it, or run `pnpm web:dev -- --port 5174` explicitly and open the printed URL.
- Docker build cannot pull the Node base image: use a locally cached image with `NODE_IMAGE=node:23-bullseye-slim docker compose up --build` on macOS/Linux or `$env:NODE_IMAGE = 'node:23-bullseye-slim'` followed by `docker compose up --build` in Windows PowerShell, or restore Docker Hub access and rerun `docker compose up --build`.
- Docker config output includes `.env` values by default. Use `docker compose config --quiet --no-env-resolution` for validation when real credentials are present, and do not share expanded config output.
- SQLite `SQLITE_IOERR_SHMOPEN` in Docker: keep the Compose defaults `SQLITE_JOURNAL_MODE=DELETE` and `SQLITE_LOCKING_MODE=EXCLUSIVE`, rebuild, and make sure no local API process is using the same `data/` database at the same time.
- SQLite `SQLITE_CORRUPT`: stop all app processes, back up `data/`, and restore from backup or remove the SQLite files to let the app create a clean database. Generated image files under `data/assets/` can be kept.
- `/api/project` returns 400 while autosaving: check Docker logs for `Project save rejected`. Large canvases are supported up to 100 MB snapshots; imported data URL images can still make snapshots very large.
- Stale or unwanted local state: stop the app and remove files under `data/`. This deletes local project state, history, and generated assets.

## License

MIT

## 友情链接

- [LINUX DO - 新的理想型社区](https://linux.do/)
