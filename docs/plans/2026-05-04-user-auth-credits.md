# User Auth Credits Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add account registration, login, administrator-managed credits, and per-user generation access control.

**Architecture:** The API owns identity, sessions, roles, credit ledger, and resource ownership in SQLite. The web app consumes `/api/auth/me` to decide whether to show login/register, canvas, gallery, or admin screens. Generation routes check credits before upstream calls and deduct only successful outputs after the provider response is persisted.

**Tech Stack:** Hono, better-sqlite3, Drizzle ORM, Node `crypto`, React 18, tldraw, TypeScript, Node test runner with `tsx`.

---

### Task 1: API Test Harness

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/test/auth.test.ts`

**Step 1: Write the failing test**

Add a Node test that imports the future auth helpers and asserts a registered user has zero credits.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @gpt-image-canvas/api test`

Expected: FAIL because the test script and auth helpers do not exist yet.

**Step 3: Add minimal test script**

Add `test`: `node --import tsx --test test/*.test.ts`.

**Step 4: Run test again**

Expected: FAIL because the auth module is still missing.

### Task 2: Database Schema

**Files:**
- Modify: `apps/api/src/schema.ts`
- Modify: `apps/api/src/database.ts`

**Step 1: Write failing tests**

Add tests for user creation, session creation, and credit transaction persistence.

**Step 2: Implement tables**

Add `users`, `sessions`, and `credit_transactions`; add `user_id` to projects, assets, generation records, and generation outputs where needed for ownership checks.

**Step 3: Run tests**

Expected: PASS for schema-backed persistence tests.

### Task 3: Auth Service

**Files:**
- Create: `apps/api/src/auth-service.ts`
- Modify: `apps/api/src/runtime.ts`
- Modify: `packages/shared/src/index.ts`

**Step 1: Write failing tests**

Cover register, duplicate username rejection, login success, login failure, session lookup, logout, and disabled user rejection.

**Step 2: Implement auth service**

Use `crypto.scrypt` with random salt for password hashes. Store session token hashes in SQLite. Initialize the first admin from `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

**Step 3: Run tests**

Expected: PASS for auth tests.

### Task 4: Credit Service

**Files:**
- Create: `apps/api/src/credit-service.ts`
- Modify: `apps/api/test/auth.test.ts`

**Step 1: Write failing tests**

Cover zero starting credits, admin grants credits, insufficient credit rejection, successful deduction, failed generation no deduction, and transaction listing without prompt/image data.

**Step 2: Implement credit service**

Keep `users.credits` as the balance and `credit_transactions` as the audit ledger. Use SQLite transactions for balance changes.

**Step 3: Run tests**

Expected: PASS for credit tests.

### Task 5: API Middleware And Routes

**Files:**
- Modify: `apps/api/src/index.ts`

**Step 1: Write failing route tests**

Use `app.request()` to cover register, login, `/api/auth/me`, admin-only provider config, admin user list, and non-admin denial.

**Step 2: Implement route guards**

Add helpers for current user lookup from `HttpOnly` Cookie, required login, and required admin role.

**Step 3: Run tests**

Expected: PASS for auth and admin route tests.

### Task 6: Generation Ownership And Credits

**Files:**
- Modify: `apps/api/src/image-generation.ts`
- Modify: `apps/api/src/project-store.ts`
- Modify: `apps/api/src/index.ts`

**Step 1: Write failing tests**

Cover user A cannot read user B gallery/assets, insufficient credits blocks generation before provider call, partial success deducts only successful outputs, and total failure deducts zero.

**Step 2: Implement ownership**

Persist `userId` on projects, assets, generation records, outputs and reference assets. Filter project, gallery, and asset reads by current user.

**Step 3: Implement deduction**

After `runTextToImageGeneration` or `runReferenceImageGeneration` returns, deduct the successful output count and return the updated user balance.

**Step 4: Run tests**

Expected: PASS for ownership and credit tests.

### Task 7: Shared Contracts

**Files:**
- Modify: `packages/shared/src/index.ts`

**Step 1: Add types**

Add `AppUser`, `AuthMeResponse`, `AdminUserListResponse`, `CreditTransactionView`, and generation response balance fields.

**Step 2: Run typecheck**

Run: `pnpm --filter @gpt-image-canvas/shared typecheck`

Expected: PASS.

### Task 8: Web Auth Shell

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/i18n.tsx`
- Create: `apps/web/src/AuthPage.tsx`

**Step 1: Implement login/register screen**

Show only Chinese login/register UI when `/api/auth/me` has no user.

**Step 2: Hide sensitive controls**

Only admins see provider settings, Codex login controls, and COS storage settings.

**Step 3: Run web typecheck**

Expected: PASS.

### Task 9: Admin UI

**Files:**
- Create: `apps/web/src/AdminPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/i18n.tsx`

**Step 1: Add admin route**

Admins see “后台” in navigation. Non-admin users cannot access it.

**Step 2: Add user management**

Show username, role, status, credits, created time, and controls to enable/disable and add/subtract credits. Do not show user prompts or images.

**Step 3: Run web typecheck**

Expected: PASS.

### Task 10: Chinese Cleanup And Entry Route

**Files:**
- Modify: `apps/web/src/i18n.tsx`
- Modify: `apps/web/src/App.tsx`
- Optionally remove import usage of `apps/web/src/HomePage.tsx`

**Step 1: Remove home entry behavior**

Map `/` to login when logged out, and to `/canvas` when logged in.

**Step 2: Translate Gallery**

Change visible Chinese text from `Gallery` to `画廊`.

**Step 3: Run build**

Expected: PASS.

### Task 11: Docs And Verification

**Files:**
- Modify: `.env.example`
- Modify: `README.zh-CN.md`
- Modify: `README.md`

**Step 1: Document admin bootstrap**

Add `ADMIN_USERNAME` and `ADMIN_PASSWORD`, credit rules, and public deployment notes.

**Step 2: Run full checks**

Run: `pnpm --filter @gpt-image-canvas/api test`, `pnpm typecheck`, `pnpm build`.

**Step 3: Browser verification**

Run `pnpm dev`, open `http://localhost:5173`, verify registration, login, admin credit grant, zero-credit blocking, and Chinese navigation.

**Step 4: Commit and push**

Commit implementation and push the current branch.
