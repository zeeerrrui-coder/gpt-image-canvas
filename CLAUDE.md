# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Toolchain

- Node `>=22`, pnpm pinned to `9.14.2` via `packageManager` in `package.json`. Activate with `corepack prepare pnpm@9.14.2 --activate`.
- TypeScript monorepo via `pnpm-workspace.yaml` (`apps/*`, `packages/*`). Root `tsconfig.base.json` aliases `@gpt-image-canvas/shared` → `packages/shared/src/index.ts`.

## Commands

Root scripts dispatch to workspace filters; always run from the repo root.

- `pnpm dev` — runs API (`apps/api`, port 8787) and Web (`apps/web`, port 5173, `strictPort`) concurrently. Vite proxies `/api` → `127.0.0.1:8787`.
- `pnpm api:dev` / `pnpm web:dev` — single-side dev.
- `pnpm typecheck` — runs `shared → web → api` in order. **The shared package is built first**; api/web typechecks both depend on `packages/shared/dist`.
- `pnpm build` — same order: `shared → web → api`.
- `pnpm start` — runs the built API (`apps/api/dist/index.js`). In production the API also serves the prebuilt web bundle from `apps/web/dist`.
- `pnpm --filter @gpt-image-canvas/api test` — Node's built-in test runner over `apps/api/test/*.test.ts` via tsx. Single test file: `pnpm --filter @gpt-image-canvas/api exec node --import tsx --test test/auth.test.ts`.
- `pnpm --filter @gpt-image-canvas/api db:generate` — drizzle-kit migration generation against `apps/api/src/schema.ts` (output: `apps/api/drizzle/`). Note: at runtime, `database.ts` uses `CREATE TABLE IF NOT EXISTS` directly rather than running these migrations.
- Docker: `docker compose config --quiet --no-env-resolution` then `docker compose up --build`. Use `--no-env-resolution` whenever real `.env` credentials may be present so secrets don't appear in expanded config output.

Required gates before completing a story (per `AGENTS.md`): `pnpm typecheck` and `pnpm build`. UI changes additionally require browser verification at `http://localhost:5173`.

## Architecture

### Workspace layout

- `apps/api` — Hono server (Node adapter), SQLite via `better-sqlite3` + drizzle-orm, OpenAI SDK, `sharp` for image preview resizing, `cos-nodejs-sdk-v5` for Tencent COS uploads.
- `apps/web` — React 18 + Vite + tldraw 4.5.10 + Tailwind. Single-page app; routing is in-component, not a router library (see `App.tsx`, `AdminPage.tsx`, `AuthPage.tsx`, `GalleryPage.tsx`, `HomePage.tsx`, `ProviderConfigDialog.tsx`).
- `packages/shared` — pure TS contracts (request/response types, presets, image-size validators, `composePrompt`). `apps/api/src/contracts.ts` re-exports from this package; the Vite config aliases the package directly to `packages/shared/src/index.ts` so the web app doesn't need a prebuild during dev.

### Request/serving topology

- Dev: two processes. Web → Vite (5173) → proxy `/api` → API (8787).
- Production / Docker: one process. `apps/api/src/index.ts` registers all `/api/*` routes, returns `{error: "not_found"}` JSON for unknown `/api/*`, and serves `apps/web/dist` static for everything else (SPA fallback). Set `PORT` to change the published port; Docker bind-mounts `./data` → `/app/data`.

### Persistence

- Single SQLite file at `${DATA_DIR}/gpt-image-canvas.sqlite` (default `./data/`, `/app/data/` in Docker). Schema defined in `apps/api/src/schema.ts` (drizzle) and bootstrapped by raw `CREATE TABLE IF NOT EXISTS` in `apps/api/src/database.ts`.
- Tables: `users`, `sessions`, `credit_transactions`, `projects`, `assets`, `generation_records`, `generation_outputs`, `generation_reference_assets`, `storage_configs`, `provider_configs`, `codex_oauth_tokens`.
- Generated image bytes live on disk under `${DATA_DIR}/assets/`; previews under `${DATA_DIR}/asset-previews/`. The DB stores metadata + COS upload state, not the image bytes.
- SQLite pragmas come from `runtime.ts` (`SQLITE_JOURNAL_MODE`, `SQLITE_LOCKING_MODE`). Default is WAL+NORMAL locally; Docker Compose forces `DELETE`+`EXCLUSIVE` to avoid `SQLITE_IOERR_SHMOPEN` on bind-mounts. `database.ts` auto-falls back to `DELETE`+`EXCLUSIVE` if WAL fails. **Never run `pnpm dev` against the same `data/` directory as a running Docker container.**

### Auth, sessions, credits

- Username/password accounts; `auth-service.ts` uses `scrypt` for hashing and stores opaque session tokens (hashed) in `sessions` with a 30-day expiry. Sessions ride on the `gic_session` cookie (HttpOnly).
- On startup, `ensureBootstrapAdmin()` reads `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env` and creates that admin only if no admin exists yet.
- Regular users register with **0 credits**. Admins grant credits via `/api/admin/users/:userId/credits`.
- Generation flow uses a **reserve → settle/refund** pattern in `credit-service.ts`: `reserveGenerationCredits` debits up-front based on `requestedCount`; on completion, only successful outputs cost 1 each, and the unused reservation is refunded via `refundGenerationCredits`. Total failures refund the full reservation.
- `/api/admin/*` and `/api/provider-config`, `/api/storage/*`, `/api/auth/codex/*` are admin-only (regular users get 403). `/api/gallery` is per-user — never returns other users' outputs.

### Provider selection

- Three sources, ordered by user preference saved in `provider_configs.source_order_json`:
  1. `env-openai` — `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_IMAGE_MODEL` from process env (read-only in UI).
  2. `local-openai` — one OpenAI-compatible profile saved through the in-app `配置` dialog. The API key is stored in SQLite and **only ever returned masked**; saves can preserve the existing key via `preserveApiKey`.
  3. `codex` — Codex OAuth tokens obtained via the device-login flow (`codex-auth.ts`). Tokens persist in the `codex_oauth_tokens` table.
- `image-provider-selection.ts` walks the order, returning the first available source. Fallback only happens **before** a request is created — once a provider is chosen, the request runs against that one.
- The active provider is reported via `/api/auth/status`. When none is available, generation endpoints return `missing_provider`.

### Image generation

- `image-generation.ts` orchestrates text-to-image (`/api/images/generate`) and reference-image edit (`/api/images/edit`). Reference inputs accept up to `MAX_REFERENCE_IMAGES = 3` data URLs (`referenceImages[]`) or asset IDs (`referenceAssetIds[]`); legacy single-reference fields exist for back-compat.
- Image size validation lives in `packages/shared/src/index.ts` (`validateImageSize`, `validateSceneImageSize`). Constraints: 512–3840 px per side, multiples of 16, aspect ratio ≤ 3:1, total pixels in `[655_360, 8_294_400]`.
- COS dual-write is best-effort: if upload fails, the local file is still served, the asset row records the failure, and the UI surfaces a cloud-backup-failed indicator. **Cloud failure never fails the generation.**

### Canvas & autosave

- `apps/web/src/App.tsx` is the canvas shell (very large file: tldraw editor, AI panel, history, dialogs). Project snapshots autosave to `/api/project` (debounce ~1.2s) up to 100 MB per snapshot. Project loading falls back to a blank canvas if the stored row is unreadable.
- `GenerationPlaceholderShape.tsx` is a custom tldraw shape used to reserve canvas space while a generation is running.
- The web app is bilingual (`i18n.tsx`); the logged-out screen and core canvas chrome are in Simplified Chinese.

## Conventions

- ESM throughout (`"type": "module"`). The API tsconfig uses `module: NodeNext`, so relative imports between `.ts` files in `apps/api/src` are written with `.js` extensions (e.g. `import { ... } from "./auth-service.js"`). Do not strip the extensions.
- Don't commit: `.env`, `data/`, `.ralph/`, `.codex-temp/`, generated images, SQLite databases, build output. `.gitignore` already covers these — verify with `git status --short` before publishing a branch.
- Secrets must come from `.env`, the runtime environment, or the local SQLite settings DB. Never log or echo `OPENAI_API_KEY`, Codex tokens, COS `SecretKey`, or session cookies. The provider-config and storage-config APIs already mask these on read; preserve that contract when extending them.
- Local agent scratch goes under `.codex-temp/`; Ralph runtime state under `.ralph/`. Both are gitignored. See `docs/ralph-execution.md` if running Ralph PRDs.

## Editing safety notes

- After changing anything in `packages/shared`, the API typecheck/test scripts will rebuild it automatically; for the web side, Vite reads the source file directly so no build is needed.
- `/api/project` returns 400 if the snapshot exceeds 100 MB. Imported data-URL images can blow this up quickly — investigate snapshot size before raising the limit.
- If `data/gpt-image-canvas.sqlite` becomes corrupt, the recovery path is: stop all processes → back up `data/` → delete the SQLite files → let the app recreate them. Files in `data/assets/` can be kept; the asset rows will be regenerated on next use only via re-imports.
