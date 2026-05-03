# Repository Notes

- Use `pnpm install`; the package manager is pinned to `pnpm@9.14.2`.
- Run `pnpm typecheck` and `pnpm build` before completing a story.
- UI stories require browser verification against the running app.
- The API app lives in `apps/api`; the web app lives in `apps/web`; shared contracts live in `packages/shared`.
- Root scripts delegate to workspace packages: `pnpm dev`, `pnpm api:dev`, `pnpm web:dev`, `pnpm typecheck`, `pnpm build`, and `pnpm start`.
- For browser verification, run `pnpm dev` and open the Vite web app, usually `http://localhost:5173`.
- For Docker verification with real `.env` credentials, run `docker compose config --quiet --no-env-resolution`; plain `docker compose config` expands env files and can print secrets. When Docker is available, run `docker compose up --build` and check the app on the configured `PORT` (default `8787`).
- Keep local agent scratch files under `.codex-temp/`; do not commit local run logs or machine-specific paths.
- Do not commit `.env`, `.ralph`, `.codex-temp`, `data`, generated images, SQLite databases, or build output.
- Secrets must only be read from `.env` or the runtime environment and must never be logged.
- For Ralph-driven work, read `docs/ralph-execution.md` before creating or running a task. Keep Ralph PRDs under `.agents/tasks/`, keep runtime state under `.ralph/`, and keep extra wrapper logs under `.codex-temp/`.
- When invoking Ralph on Windows, prefer setting `PRD_PATH` and running `.agents/ralph/loop.sh` through Git Bash; avoid CLI flags that rewrite Windows paths unexpectedly.
