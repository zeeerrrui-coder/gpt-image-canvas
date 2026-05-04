import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const testDataDir = resolve(process.cwd(), ".codex-temp", `api-auth-test-${Date.now()}`);
rmSync(testDataDir, { force: true, recursive: true });
mkdirSync(testDataDir, { recursive: true });

process.env.DATA_DIR = testDataDir;
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "admin-password";
process.env.OPENAI_API_KEY = "";
process.env.OPENAI_BASE_URL = "";

test("registered users start with zero credits", async () => {
  const { registerUser } = await import("../src/auth-service.js");

  const result = await registerUser({
    username: `user-${Date.now()}`,
    password: "user-password"
  });

  assert.equal(result.credits, 0);
  assert.equal(result.role, "user");
});

test("duplicate usernames are rejected", async () => {
  const { registerUser } = await import("../src/auth-service.js");
  const username = `duplicate-${Date.now()}`;

  await registerUser({ username, password: "user-password" });
  await assert.rejects(() => registerUser({ username, password: "user-password" }), /用户名已存在/);
});

test("login creates a session that can be resolved and logged out", async () => {
  const { authenticateSessionToken, loginUser, logoutSessionToken, registerUser } = await import("../src/auth-service.js");
  const username = `login-${Date.now()}`;
  await registerUser({ username, password: "user-password" });

  const session = await loginUser({ username, password: "user-password" });
  assert.equal(session.user.username, username);
  assert.equal(typeof session.token, "string");
  assert.ok(session.token.length >= 32);

  const currentUser = await authenticateSessionToken(session.token);
  assert.equal(currentUser?.username, username);

  logoutSessionToken(session.token);
  assert.equal(await authenticateSessionToken(session.token), undefined);
});

test("bootstrap admin is created from environment credentials", async () => {
  const { ensureBootstrapAdmin, loginUser } = await import("../src/auth-service.js");

  const admin = await ensureBootstrapAdmin();
  assert.equal(admin?.role, "admin");
  assert.equal(admin?.credits, 0);

  const session = await loginUser({ username: "admin", password: "admin-password" });
  assert.equal(session.user.role, "admin");
});

test("admin can grant credits to a user", async () => {
  const { ensureBootstrapAdmin, registerUser } = await import("../src/auth-service.js");
  const { grantUserCredits } = await import("../src/credit-service.js");
  const admin = await ensureBootstrapAdmin();
  assert.ok(admin);
  const user = await registerUser({ username: `credit-${Date.now()}`, password: "user-password" });

  const updated = grantUserCredits({
    userId: user.id,
    amount: 5,
    adminId: admin.id,
    note: "测试发放"
  });

  assert.equal(updated.credits, 5);
});

test("auth routes register, expose current user, and logout", async () => {
  const { app } = await import("../src/index.js");

  const registerResponse = await app.request("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: `route-${Date.now()}`,
      password: "user-password"
    })
  });

  assert.equal(registerResponse.status, 200);
  const cookie = registerResponse.headers.get("set-cookie");
  assert.match(cookie ?? "", /gic_session=/);
  assert.match(cookie ?? "", /Max-Age=/i);

  const meResponse = await app.request("/api/auth/me", {
    headers: {
      Cookie: cookie ?? ""
    }
  });
  assert.equal(meResponse.status, 200);
  const meBody = (await meResponse.json()) as { user?: { role?: string; credits?: number } };
  assert.equal(meBody.user?.role, "user");
  assert.equal(meBody.user?.credits, 0);

  const logoutResponse = await app.request("/api/auth/logout", {
    method: "POST",
    headers: {
      Cookie: cookie ?? ""
    }
  });
  assert.equal(logoutResponse.status, 200);
});

test("sensitive provider configuration is admin only", async () => {
  const { app } = await import("../src/index.js");

  const registerResponse = await app.request("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: `regular-${Date.now()}`,
      password: "user-password"
    })
  });
  const regularCookie = registerResponse.headers.get("set-cookie") ?? "";

  const deniedResponse = await app.request("/api/provider-config", {
    headers: {
      Cookie: regularCookie
    }
  });
  assert.equal(deniedResponse.status, 403);

  const { ensureBootstrapAdmin, loginUser } = await import("../src/auth-service.js");
  await ensureBootstrapAdmin();
  const adminSession = await loginUser({ username: "admin", password: "admin-password" });
  const allowedResponse = await app.request("/api/provider-config", {
    headers: {
      Cookie: `gic_session=${adminSession.token}`
    }
  });
  assert.equal(allowedResponse.status, 200);
});

test("admin user list does not include passwords, prompts, or images", async () => {
  const { app } = await import("../src/index.js");
  const { ensureBootstrapAdmin, loginUser, registerUser } = await import("../src/auth-service.js");
  await ensureBootstrapAdmin();
  const username = `listed-${Date.now()}`;
  await registerUser({ username, password: "user-password" });
  const adminSession = await loginUser({ username: "admin", password: "admin-password" });

  const response = await app.request("/api/admin/users", {
    headers: {
      Cookie: `gic_session=${adminSession.token}`
    }
  });

  assert.equal(response.status, 200);
  const bodyText = await response.text();
  assert.match(bodyText, /"users"/);
  assert.match(bodyText, new RegExp(`"username":"${username}"`));
  assert.doesNotMatch(bodyText, /passwordHash|prompt|asset|image/);
});

test("zero-credit generation is blocked before provider selection", async () => {
  const { app } = await import("../src/index.js");

  const registerResponse = await app.request("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: `blocked-${Date.now()}`,
      password: "user-password"
    })
  });
  const cookie = registerResponse.headers.get("set-cookie") ?? "";

  const response = await app.request("/api/images/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify({
      prompt: "一张测试图片",
      presetId: "none",
      size: { width: 1024, height: 1024 },
      quality: "auto",
      outputFormat: "png",
      count: 1
    })
  });

  assert.equal(response.status, 402);
  const body = (await response.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, "insufficient_credits");
});

test("provider failures do not deduct credits", async () => {
  const { app } = await import("../src/index.js");
  const { grantUserCredits } = await import("../src/credit-service.js");

  const registerResponse = await app.request("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: `no-deduct-${Date.now()}`,
      password: "user-password"
    })
  });
  const cookie = registerResponse.headers.get("set-cookie") ?? "";
  const registerBody = (await registerResponse.json()) as { user: { id: string } };
  grantUserCredits({
    userId: registerBody.user.id,
    amount: 1,
    adminId: registerBody.user.id,
    note: "测试额度"
  });

  const response = await app.request("/api/images/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie
    },
    body: JSON.stringify({
      prompt: "一张测试图片",
      presetId: "none",
      size: { width: 1024, height: 1024 },
      quality: "auto",
      outputFormat: "png",
      count: 1
    })
  });
  assert.notEqual(response.status, 200);

  const meResponse = await app.request("/api/auth/me", {
    headers: {
      Cookie: cookie
    }
  });
  const meBody = (await meResponse.json()) as { user?: { credits?: number } };
  assert.equal(meBody.user?.credits, 1);
});

test("project and gallery routes require login", async () => {
  const { app } = await import("../src/index.js");

  const projectResponse = await app.request("/api/project");
  assert.equal(projectResponse.status, 401);

  const galleryResponse = await app.request("/api/gallery");
  assert.equal(galleryResponse.status, 401);
});

test("authenticated users can load their own project and gallery", async () => {
  const { app } = await import("../src/index.js");

  const registerResponse = await app.request("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: `project-${Date.now()}`,
      password: "user-password"
    })
  });
  const cookie = registerResponse.headers.get("set-cookie") ?? "";

  const projectResponse = await app.request("/api/project", {
    headers: {
      Cookie: cookie
    }
  });
  assert.equal(projectResponse.status, 200);

  const galleryResponse = await app.request("/api/gallery", {
    headers: {
      Cookie: cookie
    }
  });
  assert.equal(galleryResponse.status, 200);
});

test("admin credit API grants credits and rejects non-admin users", async () => {
  const { app } = await import("../src/index.js");
  const { ensureBootstrapAdmin, loginUser } = await import("../src/auth-service.js");

  const userResponse = await app.request("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: `grant-api-${Date.now()}`,
      password: "user-password"
    })
  });
  const userCookie = userResponse.headers.get("set-cookie") ?? "";
  const userBody = (await userResponse.json()) as { user: { id: string } };

  const deniedResponse = await app.request(`/api/admin/users/${userBody.user.id}/credits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: userCookie
    },
    body: JSON.stringify({
      amount: 3
    })
  });
  assert.equal(deniedResponse.status, 403);

  await ensureBootstrapAdmin();
  const adminSession = await loginUser({ username: "admin", password: "admin-password" });
  const grantResponse = await app.request(`/api/admin/users/${userBody.user.id}/credits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `gic_session=${adminSession.token}`
    },
    body: JSON.stringify({
      amount: 3,
      note: "后台发放"
    })
  });
  assert.equal(grantResponse.status, 200);
  const grantBody = (await grantResponse.json()) as { user?: { credits?: number } };
  assert.equal(grantBody.user?.credits, 3);
});
