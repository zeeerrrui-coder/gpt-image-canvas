# Ralph Execution Rules

This document is the durable operating guide for Ralph runs in this repository. `AGENTS.md` points here so agents can keep the root instructions short while still finding the full workflow.

## When To Use Ralph

- Use Ralph when the user explicitly asks for Ralph, a Ralph task, a PRD, or multi-story autonomous execution.
- Split the work into small stories with clear dependencies and acceptance criteria. A story should be independently implementable and verifiable.
- Keep the authored PRD in `.agents/tasks/prd-<short-name>.json`. Do not store durable task definitions in `.ralph/`; that directory is runtime state.

## PRD Requirements

- Include global quality gates that match this repo: `pnpm typecheck`, `pnpm build`, and browser verification for UI stories.
- Each story should include:
  - Stable `id`, concise `title`, `description`, `status`, and `dependsOn`.
  - Acceptance criteria covering implementation, security/privacy, negative cases, and verification.
  - UI acceptance criteria for desktop/mobile layout and browser coverage when the web app changes.
- Use `open`, `in_progress`, and `done` statuses. Ralph owns status transitions during a run; do not ask the story worker to edit the PRD directly.

## Starting A Run

Run Ralph from the repository root. Prefer an explicit `PRD_PATH` environment variable so the loop reads the intended PRD.

PowerShell on Windows:

```powershell
$env:PRD_PATH = ".agents/tasks/prd-example.json"
& "C:\Program Files\Git\bin\bash.exe" ".agents/ralph/loop.sh" build 2
Remove-Item Env:\PRD_PATH
```

macOS/Linux or Git Bash:

```sh
PRD_PATH=.agents/tasks/prd-example.json .agents/ralph/loop.sh build 2
```

On Windows, avoid passing a PRD path through wrapper flags when they rewrite paths unexpectedly. If a long run needs detached logging, put wrapper scripts and logs under `.codex-temp/`.

## Monitoring

Check the PRD and run summaries instead of guessing:

```powershell
$d = Get-Content .agents\tasks\prd-example.json -Raw | ConvertFrom-Json
$d.stories | Select-Object id,status,startedAt,completedAt
Get-ChildItem .ralph\runs | Sort-Object LastWriteTime -Descending | Select-Object -First 4
git status --short
```

For each iteration, Ralph selects one actionable story, runs a fresh agent process, writes `.ralph/runs/run-...` logs, and marks the story `done` only after the worker emits `<promise>COMPLETE</promise>`.

## Verification Rules

- Follow `AGENTS.md` for repo-wide gates: `pnpm typecheck` and `pnpm build`.
- UI stories must run the app and verify behavior in a browser. Default path: `pnpm dev` and `http://localhost:5173`.
- If the default dev API does not open its port, use a clearly logged fallback such as the built API with the Vite web server, then record the fallback in the run notes.
- Browser verification should cover the pages and flows named in the story. For responsive UI, check at least one desktop and one mobile viewport.
- Do not mark a story complete just because code was written; the story is complete only after implementation, required verification, and a clean commit.

## Secrets And Local State

- Never print secrets from `.env`, runtime environment variables, SQLite databases, OAuth tokens, or local provider settings.
- Use `docker compose config --quiet --no-env-resolution` for Docker config validation when real `.env` credentials may exist.
- If a browser test saves fake credentials into local SQLite, restore or clear the test configuration before finishing.
- Treat `data/` as private runtime state. Do not commit `data/`, SQLite databases, generated images, `.env`, `.ralph/`, `.codex-temp/`, or build output.

## Commit Discipline

- Ralph story workers should commit their source, docs, and intended metadata changes.
- Before committing, check `git status --short` and avoid staging unrelated user edits.
- Do not commit `.ralph/` logs, `.codex-temp/` scratch files, local data, generated screenshots, or machine-specific paths.
- Ralph may mark a PRD story `done` after the story implementation commit. If that leaves only the PRD status metadata dirty, commit that metadata separately with a short message.
- Capture commit hashes and subjects in the final report.

## Failure Handling

- If an iteration exits non-zero, inspect the matching `.ralph/runs/run-...log` and `.ralph/errors.log`.
- Re-run only after understanding whether the failure was a code issue, a test issue, a missing tool, or an environment problem.
- Add durable process guidance to this document or `AGENTS.md` when it affects future runs. Keep per-run observations in `.ralph/` and do not commit them.
- If the run stalls, verify whether the worker process is still alive and whether the log is still changing before interrupting. Do not leave required dev servers or helper API processes running after the run finishes.

## Completion Checklist

- All PRD stories requested for the run are `done`.
- `pnpm typecheck` and `pnpm build` passed, or a docs-only exception is explicitly justified.
- Required browser verification passed for UI stories.
- Relevant implementation commits exist and are listed.
- `git status --short` is clean or only contains unrelated pre-existing user changes.
- Temporary services started for verification are stopped.
