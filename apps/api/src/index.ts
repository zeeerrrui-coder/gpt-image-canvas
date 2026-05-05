import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parsePreviewWidth, readStoredAssetPreview } from "./asset-preview.js";
import {
  adminResetUserPassword,
  authenticateSessionToken,
  changeUserPassword,
  deleteUserById,
  ensureBootstrapAdmin,
  listUsers,
  loginUser,
  logoutSessionToken,
  registerUser,
  setUserStatus,
  SESSION_DURATION_SECONDS,
  updateUserNickname,
  type AppUser
} from "./auth-service.js";
import { listCreditTransactions } from "./credit-history-service.js";
import { createRedeemCode, deleteRedeemCode, listRedeemCodes, redeemCode } from "./redeem-code-service.js";
import { getAdminStats, listErrorLogs, recordErrorLog } from "./admin-stats-service.js";
import {
  ImageJobError,
  cancelImageJob,
  createImageJob,
  drainQueue,
  getImageJobView,
  listActiveImageJobs,
  recoverInterruptedJobs
} from "./image-job-service.js";
import {
  checkAuthRateLimit,
  clearAuthFailures,
  recordAuthFailure
} from "./auth-rate-limit.js";
import {
  CreditError,
  grantUserCredits,
  refundGenerationCredits,
  reserveGenerationCredits
} from "./credit-service.js";
import {
  getAuthStatus,
  logoutCodex,
  pollCodexDeviceLogin,
  startCodexDeviceLogin
} from "./codex-auth.js";
import {
  DEFAULT_CREDIT_COSTS,
  GENERATION_COUNTS,
  IMAGE_QUALITIES,
  MAX_REFERENCE_IMAGES,
  OUTPUT_FORMATS,
  PROVIDER_SOURCE_IDS,
  SIZE_PRESETS,
  STYLE_PRESETS,
  composePrompt,
  creditCostForSize,
  validateSceneImageSize,
  type AppConfig,
  type CreditCostConfig,
  type GenerationCount,
  type GenerationRecord,
  type ImageQuality,
  type ImageSize,
  type OutputFormat,
  type ProviderSourceId,
  type ReferenceImageInput,
  type SaveLocalOpenAIProviderConfig,
  type SaveProviderConfigRequest,
  type SaveStorageConfigRequest,
  type StylePresetId
} from "./contracts.js";
import { closeDatabase } from "./database.js";
import {
  ProviderError,
  getConfiguredImageModel,
  type EditImageProviderInput,
  type ImageProviderInput
} from "./image-provider.js";
import { createConfiguredImageProvider } from "./image-provider-selection.js";
import {
  getStoredAssetFile,
  readStoredAsset,
  readStoredAssetMetadata,
  runReferenceImageGeneration,
  runTextToImageGeneration
} from "./image-generation.js";
import {
  deleteGalleryOutput,
  deleteGenerationRecord,
  getGalleryImages,
  getGenerationRecordById,
  getProjectState,
  saveProjectSnapshot
} from "./project-store.js";
import { rm } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { CosAssetStorageAdapter } from "./asset-storage.js";
import { getActiveCosStorageConfigForUser, purgeLegacyGlobalStorageConfigs } from "./storage-config.js";
import {
  createLocalProfile,
  deleteLocalProfile,
  getLocalProfileById,
  getProviderConfig,
  isProviderSourceOrder,
  saveProviderConfig,
  setActiveLocalProfile,
  updateLocalProfile
} from "./provider-config.js";
import { listLocalProfileModels, testLocalProfileConnection } from "./provider-test-service.js";
import { runtimePaths, serverConfig } from "./runtime.js";
import { getStorageConfig, saveStorageConfig, testStorageConfig } from "./storage-config.js";

const MAX_PROJECT_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 110 * 1024 * 1024;
const MAX_PROJECT_NAME_LENGTH = 120;
const SESSION_COOKIE_NAME = "gic_session";

interface ProjectPayload {
  name?: string;
  snapshotJson: string;
}

export const app = new Hono();

export async function bootstrap(): Promise<void> {
  await ensureBootstrapAdmin().catch((error) => {
    console.error("Admin bootstrap failed.", error);
  });
  const recoveredJobs = recoverInterruptedJobs();
  if (recoveredJobs > 0) {
    console.warn(`Recovered ${recoveredJobs} interrupted image jobs (refunded credits).`);
  }
  const purgedLegacy = purgeLegacyGlobalStorageConfigs();
  if (purgedLegacy > 0) {
    console.warn(`Cleared ${purgedLegacy} legacy global storage_configs row(s) (cloud storage is now per-user).`);
  }
  // Pick up jobs that were left as 'pending' by the previous shutdown.
  // Must run after recoverInterruptedJobs so any orphaned 'running' rows are
  // already cleared. Must run before serve() so the in-memory worker set is
  // primed before the first HTTP request can land.
  drainQueue();
}

// Backward-compat: existing tests expect ensureBootstrapAdmin to run on import.
// Recovery only runs when this file is the entry point (see isMainModule branch below).
void ensureBootstrapAdmin().catch((error) => {
  console.error("Admin bootstrap failed.", error);
});

app.onError((error, c) => {
  const message = error instanceof Error && error.message ? error.message : "Internal server error.";
  const code = error instanceof Error ? error.name : "internal_error";
  console.error(`${code}: ${message}`);

  void getCurrentUser(c)
    .catch(() => undefined)
    .then((user) => {
      recordErrorLog({
        path: c.req.path,
        method: c.req.method,
        status: 500,
        code,
        message,
        userId: user?.id ?? null
      });
    });

  return c.json(
    {
      error: {
        code: "internal_error",
        message: "Internal server error."
      }
    },
    500
  );
});

app.get("/api/health", (c) =>
  c.json({
    status: "ok"
  })
);

app.get("/api/config", (c) => {
  const configuredModel = getConfiguredImageModel();
  const config: AppConfig = {
    model: configuredModel,
    models: [configuredModel],
    sizePresets: SIZE_PRESETS,
    stylePresets: STYLE_PRESETS,
    qualities: IMAGE_QUALITIES,
    outputFormats: OUTPUT_FORMATS,
    counts: GENERATION_COUNTS,
    allowRegistration: isRegistrationAllowed(),
    creditCosts: getCreditCostConfig()
  };

  return c.json(config);
});

function getCreditCostConfig(): CreditCostConfig {
  return {
    cost1K: parsePositiveEnvInt(process.env.CREDIT_COST_1K, DEFAULT_CREDIT_COSTS.cost1K),
    cost2K: parsePositiveEnvInt(process.env.CREDIT_COST_2K, DEFAULT_CREDIT_COSTS.cost2K),
    cost4K: parsePositiveEnvInt(process.env.CREDIT_COST_4K, DEFAULT_CREDIT_COSTS.cost4K)
  };
}

function parsePositiveEnvInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

app.post("/api/auth/register", async (c) => {
  const limit = checkAuthRateLimit(c);
  if (!limit.allowed) {
    return rateLimitedJson(c, limit.retryAfterSeconds);
  }

  if (!isRegistrationAllowed()) {
    return c.json(errorResponse("registration_disabled", "当前不开放注册，请联系管理员。"), 403);
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseCredentialsPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    await registerUser(parsed.value);
    const session = await loginUser(parsed.value);
    setSessionCookie(c, session.token, session.expiresAt);
    clearAuthFailures(c);
    return c.json({ user: session.user });
  } catch (error) {
    recordAuthFailure(c);
    return c.json(errorResponse("auth_error", errorToMessage(error)), 400);
  }
});

app.post("/api/auth/login", async (c) => {
  const limit = checkAuthRateLimit(c);
  if (!limit.allowed) {
    return rateLimitedJson(c, limit.retryAfterSeconds);
  }

  await ensureBootstrapAdmin();

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseCredentialsPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    const session = await loginUser(parsed.value);
    setSessionCookie(c, session.token, session.expiresAt);
    clearAuthFailures(c);
    return c.json({ user: session.user });
  } catch (error) {
    recordAuthFailure(c);
    return c.json(errorResponse("auth_error", errorToMessage(error)), 401);
  }
});

app.post("/api/auth/logout", (c) => {
  logoutSessionToken(getSessionToken(c));
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/"
  });
  return c.json({ ok: true });
});

app.get("/api/auth/me", async (c) => c.json({ user: (await getCurrentUser(c)) ?? null }));

app.patch("/api/auth/profile", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseProfileUpdatePayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    const updated = updateUserNickname(user.user.id, parsed.value.nickname);
    return c.json({ user: updated });
  } catch (error) {
    return c.json(errorResponse("profile_update_error", errorToMessage(error)), 400);
  }
});

app.post("/api/auth/password", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parsePasswordChangePayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    await changeUserPassword(user.user.id, parsed.value.oldPassword, parsed.value.newPassword);
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  } catch (error) {
    return c.json(errorResponse("password_change_error", errorToMessage(error)), 400);
  }
});

app.post("/api/auth/redeem", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  if (!isRecord(payload.value) || typeof payload.value.code !== "string") {
    return c.json(errorResponse("invalid_request", "请输入兑换码。"), 400);
  }

  try {
    const result = redeemCode({ code: payload.value.code, userId: user.user.id });
    return c.json({ user: result.user, credits: result.credits });
  } catch (error) {
    return c.json(errorResponse("redeem_error", errorToMessage(error)), 400);
  }
});

app.get("/api/admin/redeem-codes", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }
  return c.json({ codes: listRedeemCodes() });
});

app.post("/api/admin/redeem-codes", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  if (!isRecord(payload.value)) {
    return c.json(errorResponse("invalid_request", "请求内容必须是 JSON 对象。"), 400);
  }

  const credits = typeof payload.value.credits === "number" ? payload.value.credits : Number.NaN;
  if (!Number.isInteger(credits) || credits <= 0) {
    return c.json(errorResponse("invalid_request", "请输入正整数积分。"), 400);
  }

  const maxUses = typeof payload.value.maxUses === "number" ? payload.value.maxUses : 1;
  const expiresAt = typeof payload.value.expiresAt === "string" ? payload.value.expiresAt : null;
  const note = typeof payload.value.note === "string" ? payload.value.note : undefined;

  try {
    const created = createRedeemCode({ credits, maxUses, expiresAt, note, adminId: admin.user.id });
    return c.json({ code: created });
  } catch (error) {
    return c.json(errorResponse("redeem_error", errorToMessage(error)), 400);
  }
});

app.delete("/api/admin/redeem-codes/:codeId", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  try {
    deleteRedeemCode(c.req.param("codeId"));
    return c.json({ ok: true });
  } catch (error) {
    return c.json(errorResponse("redeem_error", errorToMessage(error)), 400);
  }
});

app.get("/api/auth/credit-transactions", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(c.req.query("pageSize") ?? "20", 10) || 20));
  return c.json(listCreditTransactions(user.user.id, { page, pageSize }));
});

app.get("/api/admin/stats", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }
  return c.json(getAdminStats());
});

app.get("/api/admin/error-logs", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(c.req.query("pageSize") ?? "30", 10) || 30));
  return c.json(listErrorLogs({ page, pageSize }));
});

app.get("/api/admin/users", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  return c.json({
    users: listUsers()
  });
});

app.get("/api/admin/users/:userId/credit-transactions", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(c.req.query("pageSize") ?? "20", 10) || 20));
  return c.json(listCreditTransactions(c.req.param("userId"), { page, pageSize }));
});

app.post("/api/admin/users/:userId/status", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  if (!isRecord(payload.value) || (payload.value.status !== "active" && payload.value.status !== "disabled")) {
    return c.json(errorResponse("invalid_request", "状态必须是 active 或 disabled。"), 400);
  }

  const targetUserId = c.req.param("userId");
  if (targetUserId === admin.user.id && payload.value.status === "disabled") {
    return c.json(errorResponse("invalid_request", "不能禁用自己的账号。"), 400);
  }

  try {
    return c.json({ user: setUserStatus(targetUserId, payload.value.status) });
  } catch (error) {
    return c.json(errorResponse("user_status_error", errorToMessage(error)), 400);
  }
});

app.post("/api/admin/users/:userId/password-reset", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  if (!isRecord(payload.value) || typeof payload.value.password !== "string") {
    return c.json(errorResponse("invalid_request", "请输入新密码。"), 400);
  }

  try {
    await adminResetUserPassword(c.req.param("userId"), payload.value.password);
    return c.json({ ok: true });
  } catch (error) {
    return c.json(errorResponse("password_reset_error", errorToMessage(error)), 400);
  }
});

app.delete("/api/admin/users/:userId", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const targetUserId = c.req.param("userId");
  if (targetUserId === admin.user.id) {
    return c.json(errorResponse("invalid_request", "不能删除自己的账号。"), 400);
  }

  try {
    deleteUserById(targetUserId);
    return c.json({ ok: true });
  } catch (error) {
    return c.json(errorResponse("user_delete_error", errorToMessage(error)), 400);
  }
});

app.post("/api/admin/users/credits/batch", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseBatchCreditPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  const results: Array<{ userId: string; ok: boolean; user?: AppUser; error?: string }> = [];
  for (const userId of parsed.value.userIds) {
    try {
      const user = grantUserCredits({
        userId,
        amount: parsed.value.amount,
        adminId: admin.user.id,
        note: parsed.value.note
      });
      results.push({ userId, ok: true, user });
    } catch (error) {
      results.push({ userId, ok: false, error: errorToMessage(error) });
    }
  }

  return c.json({ results });
});

app.post("/api/admin/users/:userId/credits", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseCreditAdjustmentPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    return c.json({
      user: grantUserCredits({
        userId: c.req.param("userId"),
        amount: parsed.value.amount,
        adminId: admin.user.id,
        note: parsed.value.note
      })
    });
  } catch (error) {
    return c.json(errorResponse("credit_error", errorToMessage(error)), 400);
  }
});

app.get("/api/auth/status", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  return c.json(getAuthStatus());
});

app.get("/api/provider-config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  return c.json(getProviderConfig());
});

app.put("/api/provider-config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseProviderConfigPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    return c.json(saveProviderConfig(parsed.value));
  } catch (error) {
    return c.json(errorResponse("provider_config_error", errorToMessage(error)), 400);
  }
});

app.post("/api/provider-config/profiles", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseCreateProfilePayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    return c.json({ profile: createLocalProfile(parsed.value) });
  } catch (error) {
    return c.json(errorResponse("provider_profile_error", errorToMessage(error)), 400);
  }
});

app.patch("/api/provider-config/profiles/:profileId", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseUpdateProfilePayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    return c.json({ profile: updateLocalProfile(c.req.param("profileId"), parsed.value) });
  } catch (error) {
    return c.json(errorResponse("provider_profile_error", errorToMessage(error)), 400);
  }
});

app.delete("/api/provider-config/profiles/:profileId", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  try {
    return c.json(deleteLocalProfile(c.req.param("profileId")));
  } catch (error) {
    return c.json(errorResponse("provider_profile_error", errorToMessage(error)), 400);
  }
});

app.post("/api/provider-config/profiles/:profileId/activate", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  try {
    return c.json(setActiveLocalProfile(c.req.param("profileId")));
  } catch (error) {
    return c.json(errorResponse("provider_profile_error", errorToMessage(error)), 400);
  }
});

app.post("/api/provider-config/profiles/active/clear", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  try {
    return c.json(setActiveLocalProfile(null));
  } catch (error) {
    return c.json(errorResponse("provider_profile_error", errorToMessage(error)), 400);
  }
});

app.post("/api/provider-config/profiles/:profileId/test", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const profile = getLocalProfileById(c.req.param("profileId"));
  if (!profile) {
    return c.json(errorResponse("not_found", "Local OpenAI profile not found."), 404);
  }

  return c.json(await testLocalProfileConnection(profile));
});

app.get("/api/provider-config/profiles/:profileId/models", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const profile = getLocalProfileById(c.req.param("profileId"));
  if (!profile) {
    return c.json(errorResponse("not_found", "Local OpenAI profile not found."), 404);
  }

  try {
    const models = await listLocalProfileModels(profile);
    return c.json({ models });
  } catch (error) {
    return c.json(errorResponse("provider_profile_error", errorToMessage(error)), 400);
  }
});

app.post("/api/auth/codex/device/start", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  try {
    return c.json(await startCodexDeviceLogin(c.req.raw.signal));
  } catch (error) {
    if (error instanceof ProviderError) {
      return providerErrorJson(c, error);
    }

    throw error;
  }
});

app.post("/api/auth/codex/device/poll", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseCodexPollPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    return c.json(await pollCodexDeviceLogin(parsed.value, c.req.raw.signal));
  } catch (error) {
    if (error instanceof ProviderError) {
      return providerErrorJson(c, error);
    }

    throw error;
  }
});

app.post("/api/auth/codex/logout", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  return c.json(logoutCodex());
});

app.get("/api/project", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  return c.json(getProjectState(user.user.id));
});

app.get("/api/gallery", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  return c.json(getGalleryImages(user.user.id));
});

app.delete("/api/gallery/:outputId", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const deleted = deleteGalleryOutput(c.req.param("outputId"), user.user.id);
  if (!deleted) {
    return c.json(errorResponse("not_found", "找不到请求的画廊图片记录。"), 404);
  }

  return c.json({
    ok: true
  });
});

app.get("/api/storage/config", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  return c.json(getStorageConfig(user.user.id));
});

app.put("/api/storage/config", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseStorageConfigPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    return c.json(await saveStorageConfig(user.user.id, parsed.value));
  } catch (error) {
    return c.json(errorResponse("storage_config_error", errorToMessage(error)), 400);
  }
});

app.post("/api/storage/config/test", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseStorageConfigPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  return c.json(await testStorageConfig(user.user.id, parsed.value));
});

app.get("/api/assets/:id/preview", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const parsedWidth = parsePreviewWidth(c.req.query("width"));
  if (!parsedWidth.ok) {
    return c.json(errorResponse(parsedWidth.code, parsedWidth.message), 400);
  }

  if (!getStoredAssetFile(c.req.param("id"), user.user.id)) {
    return c.json(errorResponse("not_found", "Asset not found."), 404);
  }

  const preview = await readStoredAssetPreview(c.req.param("id"), parsedWidth.width, user.user.id);
  if (!preview) {
    return c.json(errorResponse("not_found", "Asset not found."), 404);
  }

  return new Response(new Uint8Array(preview.bytes), {
    status: 200,
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${downloadFileName(c.req.param("id"))}-${preview.width}.webp"`,
      "Content-Type": "image/webp"
    }
  });
});

app.get("/api/assets/:id/metadata", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const metadata = await readStoredAssetMetadata(c.req.param("id"), user.user.id);
  if (!metadata) {
    return c.json(errorResponse("not_found", "Asset not found."), 404);
  }

  return c.json(metadata);
});

app.get("/api/assets/:id/download", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const asset = await readStoredAsset(c.req.param("id"), user.user.id);
  if (!asset) {
    return c.json(errorResponse("not_found", "找不到请求的图像资源。"), 404);
  }

  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `attachment; filename="${downloadFileName(asset.file.fileName)}"`,
      "Content-Type": asset.file.mimeType
    }
  });
});

app.get("/api/assets/:id", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const asset = await readStoredAsset(c.req.param("id"), user.user.id);
  if (!asset) {
    return c.json(errorResponse("not_found", "找不到请求的图像资源。"), 404);
  }

  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": `inline; filename="${asset.file.fileName}"`,
      "Content-Type": asset.file.mimeType
    }
  });
});

app.put("/api/project", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    logProjectSaveRejected(payload.error, c.req.raw);
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseProjectPayload(payload.value);
  if (!parsed.ok) {
    logProjectSaveRejected(parsed.error, c.req.raw);
    return c.json(parsed.error, 400);
  }

  return c.json(saveProjectSnapshot(parsed.value, user.user.id));
});

app.post("/api/images/generate", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseGeneratePayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    const job = createImageJob({
      userId: user.user.id,
      mode: "generate",
      payload: parsed.value,
      creditCosts: getCreditCostConfig()
    });
    return c.json({ jobId: job.jobId, reservedAmount: job.reservedAmount });
  } catch (error) {
    if (error instanceof ImageJobError) {
      return errorJson(error.code, error.message, error.status);
    }
    if (error instanceof CreditError) {
      return errorJson(error.code, error.message, error.status);
    }
    if (error instanceof ProviderError) {
      return providerErrorJson(c, error);
    }
    throw error;
  }
});

app.post("/api/images/edit", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, (payload.status ?? 400) as 400 | 413);
  }

  const parsed = parseEditPayload(payload.value, user.user.id);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    const job = createImageJob({
      userId: user.user.id,
      mode: "edit",
      payload: parsed.value,
      creditCosts: getCreditCostConfig()
    });
    return c.json({ jobId: job.jobId, reservedAmount: job.reservedAmount });
  } catch (error) {
    if (error instanceof ImageJobError) {
      return errorJson(error.code, error.message, error.status);
    }
    if (error instanceof CreditError) {
      return errorJson(error.code, error.message, error.status);
    }
    if (error instanceof ProviderError) {
      return providerErrorJson(c, error);
    }
    throw error;
  }
});

app.get("/api/images/jobs", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }
  const onlyActive = c.req.query("active") === "true";
  if (!onlyActive) {
    // Today only the ?active=true variant is supported. Listing all of a
    // user's history goes through other endpoints (gallery, etc.).
    return c.json(errorResponse("invalid_request", "请使用 ?active=true 查询正在进行的任务。"), 400);
  }
  const jobs = listActiveImageJobs(user.user.id, (id) => getGenerationRecordById(id, user.user.id));
  return c.json({ jobs });
});

app.get("/api/images/jobs/:jobId", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }
  const view = getImageJobView(c.req.param("jobId"), user.user.id, (id) => getGenerationRecordById(id, user.user.id));
  if (!view) {
    return c.json(errorResponse("not_found", "找不到该生成任务。"), 404);
  }
  return c.json({ job: view });
});

app.delete("/api/generations/:generationId", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }
  const result = deleteGenerationRecord(c.req.param("generationId"), user.user.id);
  if (!result.ok) {
    return c.json(errorResponse("not_found", "找不到该生成记录。"), 404);
  }
  for (const relativePath of result.assetFilePaths) {
    const filePath = resolvePath(runtimePaths.dataDir, relativePath);
    void rm(filePath, { force: true }).catch(() => undefined);
  }
  if (result.cloudObjects.length > 0) {
    const cosConfig = getActiveCosStorageConfigForUser(user.user.id);
    if (cosConfig) {
      const adapter = new CosAssetStorageAdapter(cosConfig);
      for (const location of result.cloudObjects) {
        if (location.bucket !== cosConfig.bucket || location.region !== cosConfig.region) {
          continue;
        }
        void adapter
          .deleteObject({ bucket: location.bucket, region: location.region, key: location.objectKey })
          .catch((error) => {
            console.warn(`Failed to delete COS object ${location.objectKey}:`, error instanceof Error ? error.message : error);
          });
      }
    }
  }
  return c.json({ ok: true });
});

app.post("/api/images/jobs/:jobId/cancel", async (c) => {
  const user = await requireUser(c);
  if (!user.ok) {
    return user.response;
  }
  const ok = cancelImageJob(c.req.param("jobId"), user.user.id);
  if (!ok) {
    return c.json(errorResponse("invalid_request", "任务无法取消（可能已结束）。"), 400);
  }
  return c.json({ ok: true });
});

const webDistRoot = relative(process.cwd(), runtimePaths.webDistDir) || ".";

app.get("/api/*", (c) => c.json(errorResponse("not_found", "Not found."), 404));

app.get("*", serveStatic({ root: webDistRoot }));
app.get(
  "*",
  serveStatic({
    root: webDistRoot,
    path: "index.html",
    onNotFound: () => {
      console.error(`Built web bundle not found at ${runtimePaths.webDistDir}. Run pnpm build before pnpm start.`);
    }
  })
);

function errorResponse(code: string, message: string): ErrorResponseBody {
  return {
    error: {
      code,
      message
    }
  };
}

function errorJson(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify(errorResponse(code, message)), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function rateLimitedJson(_c: Context, retryAfterSeconds: number | undefined): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    headers["Retry-After"] = String(retryAfterSeconds);
  }
  return new Response(
    JSON.stringify(errorResponse("rate_limited", "登录尝试过于频繁，请稍后再试。")),
    {
      status: 429,
      headers
    }
  );
}

function isRegistrationAllowed(): boolean {
  const value = process.env.ALLOW_REGISTRATION?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return true;
  }
  return value !== "false" && value !== "0" && value !== "no" && value !== "off";
}

interface CredentialsPayload {
  username: string;
  password: string;
}

type AuthGuardResult =
  | {
      ok: true;
      user: AppUser;
    }
  | {
      ok: false;
      response: Response;
    };

function setSessionCookie(c: Context, token: string, expiresAt: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    expires: new Date(expiresAt),
    httpOnly: true,
    maxAge: SESSION_DURATION_SECONDS,
    path: "/",
    sameSite: "Lax",
    secure: isSecureRequest(c)
  });
}

function isSecureRequest(c: Context): boolean {
  const url = new URL(c.req.url);
  if (url.protocol === "https:") {
    return true;
  }

  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    const first = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (first === "https") {
      return true;
    }
  }

  return false;
}

function getSessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}

async function getCurrentUser(c: Context): Promise<AppUser | undefined> {
  return authenticateSessionToken(getSessionToken(c));
}

async function requireUser(c: Context): Promise<AuthGuardResult> {
  const user = await getCurrentUser(c);
  if (!user) {
    return {
      ok: false,
      response: c.json(errorResponse("unauthorized", "请先登录。"), 401)
    };
  }

  return {
    ok: true,
    user
  };
}

async function requireAdmin(c: Context): Promise<AuthGuardResult> {
  const user = await requireUser(c);
  if (!user.ok) {
    return user;
  }

  if (user.user.role !== "admin") {
    return {
      ok: false,
      response: c.json(errorResponse("forbidden", "需要管理员权限。"), 403)
    };
  }

  return user;
}

function parseCredentialsPayload(input: unknown): ParseResult<CredentialsPayload> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "请求内容必须是 JSON 对象。")
    };
  }

  if (typeof input.username !== "string" || input.username.trim().length === 0) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "请输入用户名。")
    };
  }

  if (typeof input.password !== "string" || input.password.length < 8) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "密码至少需要 8 位。")
    };
  }

  return {
    ok: true,
    value: {
      username: input.username,
      password: input.password
    }
  };
}

function parseProfileUpdatePayload(input: unknown): ParseResult<{ nickname: string | null }> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "请求内容必须是 JSON 对象。")
    };
  }

  if (input.nickname === undefined || input.nickname === null) {
    return { ok: true, value: { nickname: null } };
  }

  if (typeof input.nickname !== "string") {
    return {
      ok: false,
      error: errorResponse("invalid_request", "昵称必须是字符串。")
    };
  }

  return { ok: true, value: { nickname: input.nickname } };
}

function parsePasswordChangePayload(input: unknown): ParseResult<{ oldPassword: string; newPassword: string }> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "请求内容必须是 JSON 对象。")
    };
  }

  if (typeof input.oldPassword !== "string" || input.oldPassword.length === 0) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "请输入旧密码。")
    };
  }

  if (typeof input.newPassword !== "string" || input.newPassword.length < 8) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "新密码至少需要 8 位。")
    };
  }

  return {
    ok: true,
    value: {
      oldPassword: input.oldPassword,
      newPassword: input.newPassword
    }
  };
}

function parseBatchCreditPayload(input: unknown): ParseResult<{ userIds: string[]; amount: number; note?: string }> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "请求内容必须是 JSON 对象。")
    };
  }

  if (!Array.isArray(input.userIds) || input.userIds.length === 0) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "请选择至少一个用户。")
    };
  }

  const userIds: string[] = [];
  for (const userId of input.userIds) {
    if (typeof userId !== "string" || userId.trim().length === 0) {
      return {
        ok: false,
        error: errorResponse("invalid_request", "用户 ID 必须是字符串。")
      };
    }
    userIds.push(userId);
  }

  const amount = typeof input.amount === "number" ? input.amount : Number.NaN;
  if (!Number.isInteger(amount) || amount === 0) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "积分变动必须是非零整数。")
    };
  }

  return {
    ok: true,
    value: {
      userIds,
      amount,
      note: typeof input.note === "string" ? input.note : undefined
    }
  };
}

function parseCreditAdjustmentPayload(input: unknown): ParseResult<{ amount: number; note?: string }> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "请求内容必须是 JSON 对象。")
    };
  }

  const amount = typeof input.amount === "number" ? input.amount : Number.NaN;
  if (!Number.isInteger(amount) || amount === 0) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "积分变动必须是非零整数。")
    };
  }

  return {
    ok: true,
    value: {
      amount,
      note: typeof input.note === "string" ? input.note : undefined
    }
  };
}

function downloadFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
  };
}

type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: ErrorResponseBody;
      status?: number;
    };

function logProjectSaveRejected(error: ErrorResponseBody, request: Request): void {
  console.warn(
    `Project save rejected: ${error.error.code}. ${error.error.message}${formatRequestBodySummary(request)}`
  );
}

function formatRequestBodySummary(request: Request): string {
  const contentType = sanitizeHeaderValue(request.headers.get("content-type"));
  const contentLength = sanitizeHeaderValue(request.headers.get("content-length"));
  const transferEncoding = sanitizeHeaderValue(request.headers.get("transfer-encoding"));
  const bodySize = contentLength
    ? `content-length=${contentLength}`
    : transferEncoding
      ? `transfer-encoding=${transferEncoding}`
      : "content-length=unknown";

  return ` (${bodySize}, content-type=${contentType || "missing"})`;
}

function sanitizeHeaderValue(value: string | null): string {
  return (value ?? "").replace(/[\r\n]/gu, " ").trim().slice(0, 120);
}

function providerErrorJson(_c: Context, error: ProviderError) {
  const body = errorResponse(error.code, error.message);

  return new Response(JSON.stringify(body), {
    status: providerHttpStatus(error.status),
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function providerHttpStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function successfulOutputCount(record: GenerationRecord): number {
  return record.outputs.filter((output) => output.status === "succeeded" && output.asset).length;
}

function parseGeneratePayload(input: unknown): ParseResult<ImageProviderInput> {
  const base = parseBaseImagePayload(input);
  if (!base.ok) {
    return base;
  }

  return {
    ok: true,
    value: base.value
  };
}

function parseCodexPollPayload(input: unknown): ParseResult<{ deviceAuthId: string; userCode: string }> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "Codex 登录轮询请求必须是 JSON 对象。")
    };
  }

  const deviceAuthId = parseOptionalString(input.deviceAuthId);
  const userCode = parseOptionalString(input.userCode);

  if (!deviceAuthId || !userCode) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "Codex 登录轮询缺少设备码。")
    };
  }

  return {
    ok: true,
    value: {
      deviceAuthId,
      userCode
    }
  };
}

function parseEditPayload(input: unknown, userId: string): ParseResult<EditImageProviderInput> {
  const base = parseBaseImagePayload(input);
  if (!base.ok) {
    return base;
  }

  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("unsupported_provider_behavior", "编辑图像需要提供 1-3 张参考图像。")
    };
  }

  const referenceImages = parseReferenceImages(input);
  if (!referenceImages.ok) {
    return referenceImages;
  }

  const referenceAssetIds = parseReferenceAssetIds(input, referenceImages.value.length);
  if (!referenceAssetIds.ok) {
    return referenceAssetIds;
  }

  for (const referenceAssetId of referenceAssetIds.value) {
    if (!getStoredAssetFile(referenceAssetId, userId)) {
      return {
        ok: false,
        error: errorResponse("invalid_request", "找不到可记录的本地参考图像资源。")
      };
    }
  }

  return {
    ok: true,
    value: {
      ...base.value,
      referenceImages: referenceImages.value,
      referenceImage: referenceImages.value[0],
      referenceAssetIds: referenceAssetIds.value.length > 0 ? referenceAssetIds.value : undefined,
      referenceAssetId: referenceAssetIds.value[0]
    }
  };
}

function parseReferenceImages(input: Record<string, unknown>): ParseResult<ReferenceImageInput[]> {
  const rawReferenceImages = Array.isArray(input.referenceImages)
    ? input.referenceImages
    : isRecord(input.referenceImage)
      ? [input.referenceImage]
      : undefined;

  if (!rawReferenceImages) {
    return {
      ok: false,
      error: errorResponse("unsupported_provider_behavior", "编辑图像需要提供 1-3 张参考图像。")
    };
  }

  if (rawReferenceImages.length < 1 || rawReferenceImages.length > MAX_REFERENCE_IMAGES) {
    return {
      ok: false,
      error: errorResponse("unsupported_provider_behavior", `参考图像数量必须是 1-${MAX_REFERENCE_IMAGES} 张。`)
    };
  }

  const referenceImages: ReferenceImageInput[] = [];
  for (const rawReferenceImage of rawReferenceImages) {
    if (!isRecord(rawReferenceImage)) {
      return {
        ok: false,
        error: errorResponse("unsupported_provider_behavior", "参考图像格式不受支持。")
      };
    }

    const dataUrl = rawReferenceImage.dataUrl;
    if (typeof dataUrl !== "string" || dataUrl.trim().length === 0) {
      return {
        ok: false,
        error: errorResponse("unsupported_provider_behavior", "参考图像格式不受支持。")
      };
    }

    const fileName = rawReferenceImage.fileName;
    referenceImages.push({
      dataUrl,
      fileName: typeof fileName === "string" && fileName.trim() ? fileName.trim() : undefined
    });
  }

  return {
    ok: true,
    value: referenceImages
  };
}

function parseReferenceAssetIds(input: Record<string, unknown>, referenceImageCount: number): ParseResult<string[]> {
  const legacyReferenceAssetId = parseOptionalString(input.referenceAssetId);
  const rawReferenceAssetIds = Array.isArray(input.referenceAssetIds)
    ? input.referenceAssetIds
    : legacyReferenceAssetId
      ? [legacyReferenceAssetId]
      : [];

  if (
    rawReferenceAssetIds.length > MAX_REFERENCE_IMAGES ||
    (rawReferenceAssetIds.length > 0 && rawReferenceAssetIds.length !== referenceImageCount)
  ) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "参考图像资源 ID 数量必须与参考图像数量一致。")
    };
  }

  const referenceAssetIds: string[] = [];
  for (const rawReferenceAssetId of rawReferenceAssetIds) {
    const referenceAssetId = parseOptionalString(rawReferenceAssetId);
    if (!referenceAssetId) {
      return {
        ok: false,
        error: errorResponse("invalid_request", "参考图像资源 ID 格式不受支持。")
      };
    }

    referenceAssetIds.push(referenceAssetId);
  }

  return {
    ok: true,
    value: referenceAssetIds
  };
}

function parseStorageConfigPayload(input: unknown): ParseResult<SaveStorageConfigRequest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_storage_config", "Storage config payload must be a JSON object.")
    };
  }

  const enabled = input.enabled === true;
  if (!enabled) {
    return {
      ok: true,
      value: {
        enabled: false,
        provider: "cos"
      }
    };
  }

  const provider = parseOptionalString(input.provider) ?? "cos";
  if (provider !== "cos") {
    return {
      ok: false,
      error: errorResponse("invalid_storage_provider", "Only Tencent COS storage is supported.")
    };
  }

  if (!isRecord(input.cos)) {
    return {
      ok: false,
      error: errorResponse("invalid_storage_config", "COS config must be a JSON object.")
    };
  }

  return {
    ok: true,
    value: {
      enabled: true,
      provider: "cos",
      cos: {
        secretId: stringValue(input.cos.secretId) ?? "",
        secretKey: stringValue(input.cos.secretKey),
        preserveSecret: input.cos.preserveSecret === true,
        bucket: stringValue(input.cos.bucket) ?? "",
        region: stringValue(input.cos.region) ?? "",
        keyPrefix: stringValue(input.cos.keyPrefix) ?? ""
      }
    }
  };
}

function parseProviderConfigPayload(input: unknown): ParseResult<SaveProviderConfigRequest> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_provider_config", "Provider config payload must be a JSON object.")
    };
  }

  const sourceOrder = parseProviderSourceOrderPayload(input.sourceOrder);
  if (!sourceOrder.ok) {
    return sourceOrder;
  }

  if (input.localOpenAI === undefined) {
    return {
      ok: true,
      value: {
        sourceOrder: sourceOrder.value
      }
    };
  }

  const localOpenAI = parseLocalOpenAIProviderConfig(input.localOpenAI);
  if (!localOpenAI.ok) {
    return localOpenAI;
  }

  return {
    ok: true,
    value: {
      sourceOrder: sourceOrder.value,
      localOpenAI: localOpenAI.value
    }
  };
}

function parseProviderSourceOrderPayload(input: unknown): ParseResult<ProviderSourceId[]> {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_provider_source_order", "Provider source order must be an array.")
    };
  }

  if (!isProviderSourceOrder(input)) {
    return {
      ok: false,
      error: errorResponse(
        "invalid_provider_source_order",
        `Provider source order must contain each supported source exactly once: ${PROVIDER_SOURCE_IDS.join(", ")}.`
      )
    };
  }

  return {
    ok: true,
    value: [...input]
  };
}

function parseCreateProfilePayload(input: unknown): ParseResult<{ name: string; apiKey: string; baseUrl?: string; model?: string; timeoutMs?: number }> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_provider_config", "Profile payload must be a JSON object.")
    };
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return { ok: false, error: errorResponse("invalid_provider_config", "请填写配置名称。") };
  }
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    return { ok: false, error: errorResponse("invalid_provider_config", "请填写 API Key。") };
  }

  const result: { name: string; apiKey: string; baseUrl?: string; model?: string; timeoutMs?: number } = {
    name: input.name,
    apiKey: input.apiKey
  };

  if (Object.hasOwn(input, "baseUrl")) {
    if (typeof input.baseUrl !== "string") {
      return { ok: false, error: errorResponse("invalid_provider_config", "Base URL 必须是字符串。") };
    }
    result.baseUrl = input.baseUrl;
  }
  if (Object.hasOwn(input, "model")) {
    if (typeof input.model !== "string") {
      return { ok: false, error: errorResponse("invalid_provider_config", "模型必须是字符串。") };
    }
    result.model = input.model;
  }
  if (Object.hasOwn(input, "timeoutMs")) {
    const timeoutMs = parsePositiveIntegerValue(input.timeoutMs);
    if (!timeoutMs) {
      return { ok: false, error: errorResponse("invalid_provider_config", "超时必须是正整数。") };
    }
    result.timeoutMs = timeoutMs;
  }

  return { ok: true, value: result };
}

function parseUpdateProfilePayload(input: unknown): ParseResult<{ name?: string; apiKey?: string; preserveApiKey?: boolean; baseUrl?: string; model?: string; timeoutMs?: number }> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_provider_config", "Profile payload must be a JSON object.")
    };
  }

  const result: { name?: string; apiKey?: string; preserveApiKey?: boolean; baseUrl?: string; model?: string; timeoutMs?: number } = {};
  if (Object.hasOwn(input, "name")) {
    if (typeof input.name !== "string") {
      return { ok: false, error: errorResponse("invalid_provider_config", "名称必须是字符串。") };
    }
    result.name = input.name;
  }
  if (Object.hasOwn(input, "apiKey")) {
    if (typeof input.apiKey !== "string") {
      return { ok: false, error: errorResponse("invalid_provider_config", "API Key 必须是字符串。") };
    }
    result.apiKey = input.apiKey;
  }
  if (input.preserveApiKey === true) {
    result.preserveApiKey = true;
  }
  if (Object.hasOwn(input, "baseUrl")) {
    if (typeof input.baseUrl !== "string") {
      return { ok: false, error: errorResponse("invalid_provider_config", "Base URL 必须是字符串。") };
    }
    result.baseUrl = input.baseUrl;
  }
  if (Object.hasOwn(input, "model")) {
    if (typeof input.model !== "string") {
      return { ok: false, error: errorResponse("invalid_provider_config", "模型必须是字符串。") };
    }
    result.model = input.model;
  }
  if (Object.hasOwn(input, "timeoutMs")) {
    const timeoutMs = parsePositiveIntegerValue(input.timeoutMs);
    if (!timeoutMs) {
      return { ok: false, error: errorResponse("invalid_provider_config", "超时必须是正整数。") };
    }
    result.timeoutMs = timeoutMs;
  }
  return { ok: true, value: result };
}

function parseLocalOpenAIProviderConfig(input: unknown): ParseResult<SaveLocalOpenAIProviderConfig> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_provider_config", "Local OpenAI config must be a JSON object.")
    };
  }

  const config: SaveLocalOpenAIProviderConfig = {
    preserveApiKey: input.preserveApiKey === true
  };

  if (Object.hasOwn(input, "apiKey")) {
    if (typeof input.apiKey !== "string") {
      return {
        ok: false,
        error: errorResponse("invalid_provider_config", "Local OpenAI API key must be a string.")
      };
    }
    config.apiKey = input.apiKey;
  }

  if (Object.hasOwn(input, "baseUrl")) {
    if (typeof input.baseUrl !== "string") {
      return {
        ok: false,
        error: errorResponse("invalid_provider_config", "Local OpenAI base URL must be a string.")
      };
    }
    config.baseUrl = input.baseUrl;
  }

  if (Object.hasOwn(input, "model")) {
    if (typeof input.model !== "string") {
      return {
        ok: false,
        error: errorResponse("invalid_provider_config", "Local OpenAI model must be a string.")
      };
    }
    config.model = input.model;
  }

  if (Object.hasOwn(input, "timeoutMs")) {
    const timeoutMs = parsePositiveIntegerValue(input.timeoutMs);
    if (!timeoutMs) {
      return {
        ok: false,
        error: errorResponse("invalid_provider_config", "Local OpenAI timeout must be a positive integer.")
      };
    }
    config.timeoutMs = timeoutMs;
  }

  return {
    ok: true,
    value: config
  };
}

function parseBaseImagePayload(input: unknown): ParseResult<ImageProviderInput> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_request", "请求内容必须是 JSON 对象。")
    };
  }

  const prompt = input.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return {
      ok: false,
      error: errorResponse("invalid_prompt", "请输入有效的提示词。")
    };
  }

  const stylePreset = parseStylePreset(input);
  if (!stylePreset.ok) {
    return stylePreset;
  }

  const size = parseSize(input.size);
  if (!size.ok) {
    return size;
  }

  const sizePresetId = parseOptionalString(input.sizePresetId) ?? parseOptionalString(input.scenePresetId) ?? parseSizePresetFromPresetId(input.presetId);
  const resolvedSize = validateSceneImageSize({
    size: size.value,
    sizePresetId
  });

  if (!resolvedSize.ok) {
    return {
      ok: false,
      error: errorResponse(resolvedSize.code, resolvedSize.message)
    };
  }

  const quality = parseQuality(input.quality);
  if (!quality.ok) {
    return quality;
  }

  const outputFormat = parseOutputFormat(input.outputFormat);
  if (!outputFormat.ok) {
    return outputFormat;
  }

  const count = parseCount(input.count);
  if (!count.ok) {
    return count;
  }

  return {
    ok: true,
    value: {
      originalPrompt: prompt.trim(),
      presetId: stylePreset.value,
      prompt: composePrompt(prompt, stylePreset.value),
      size: resolvedSize.size,
      sizeApiValue: resolvedSize.apiValue,
      quality: quality.value,
      outputFormat: outputFormat.value,
      count: count.value
    }
  };
}

function parseStylePreset(input: Record<string, unknown>): ParseResult<StylePresetId> {
  const presetId = parseOptionalString(input.stylePresetId) ?? parseStylePresetFromPresetId(input.presetId) ?? "none";

  if (!STYLE_PRESETS.some((preset) => preset.id === presetId)) {
    return {
      ok: false,
      error: errorResponse("invalid_prompt", "不支持的风格预设。")
    };
  }

  return {
    ok: true,
    value: presetId as StylePresetId
  };
}

function parseSize(value: unknown): ParseResult<ImageSize> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: errorResponse("invalid_size", "请提供有效的图像尺寸。")
    };
  }

  return {
    ok: true,
    value: {
      width: parseDimension(value.width),
      height: parseDimension(value.height)
    }
  };
}

function parseQuality(value: unknown): ParseResult<ImageQuality> {
  if (value === undefined) {
    return {
      ok: true,
      value: "auto"
    };
  }

  if (typeof value === "string" && IMAGE_QUALITIES.includes(value as ImageQuality)) {
    return {
      ok: true,
      value: value as ImageQuality
    };
  }

  return {
    ok: false,
    error: errorResponse("invalid_request", "不支持的图像质量设置。")
  };
}

function parseOutputFormat(value: unknown): ParseResult<OutputFormat> {
  if (value === undefined) {
    return {
      ok: true,
      value: "png"
    };
  }

  if (typeof value === "string" && OUTPUT_FORMATS.includes(value as OutputFormat)) {
    return {
      ok: true,
      value: value as OutputFormat
    };
  }

  return {
    ok: false,
    error: errorResponse("invalid_request", "不支持的输出格式。")
  };
}

function parseCount(value: unknown): ParseResult<GenerationCount> {
  if (value === undefined) {
    return {
      ok: true,
      value: 1
    };
  }

  if (typeof value === "number" && GENERATION_COUNTS.includes(value as GenerationCount)) {
    return {
      ok: true,
      value: value as GenerationCount
    };
  }

  return {
    ok: false,
    error: errorResponse("invalid_request", "生成数量只能是 1、2、4、8 或 16。")
  };
}

function parseDimension(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function parsePositiveIntegerValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Request failed.";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function parseStylePresetFromPresetId(value: unknown): string | undefined {
  const presetId = parseOptionalString(value);
  return presetId && STYLE_PRESETS.some((preset) => preset.id === presetId) ? presetId : undefined;
}

function parseSizePresetFromPresetId(value: unknown): string | undefined {
  const presetId = parseOptionalString(value);
  return presetId && SIZE_PRESETS.some((preset) => preset.id === presetId) ? presetId : undefined;
}

async function readJson(request: Request): Promise<ParseResult<unknown>> {
  const contentType = request.headers.get("content-type");
  if (contentType && !isJsonContentType(contentType)) {
    return {
      ok: false,
      error: errorResponse("unsupported_media_type", "请求 Content-Type 必须是 application/json。")
    };
  }

  const declaredLength = parseContentLengthHeader(request.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > MAX_REQUEST_BODY_BYTES) {
    return {
      ok: false,
      error: errorResponse("payload_too_large", `请求体不能超过 ${formatBytes(MAX_REQUEST_BODY_BYTES)}。`),
      status: 413
    };
  }

  let bodyText: string;
  try {
    bodyText = await readBodyTextWithLimit(request, MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return {
        ok: false,
        error: errorResponse("payload_too_large", `请求体不能超过 ${formatBytes(MAX_REQUEST_BODY_BYTES)}。`),
        status: 413
      };
    }
    return {
      ok: false,
      error: errorResponse("invalid_request_body", "请求体读取失败，请重试。")
    };
  }

  if (bodyText.trim().length === 0) {
    return {
      ok: false,
      error: errorResponse("empty_json", "请求体不能为空，必须是有效的 JSON。")
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(bodyText) as unknown
    };
  } catch {
    return {
      ok: false,
      error: errorResponse("invalid_json", "请求体必须是有效的 JSON。")
    };
  }
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large.");
    this.name = "PayloadTooLargeError";
  }
}

function parseContentLengthHeader(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBodyTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  const body = request.body;
  if (!body) {
    const bodyText = await request.text();
    if (Buffer.byteLength(bodyText, "utf8") > maxBytes) {
      throw new PayloadTooLargeError();
    }
    return bodyText;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore cancel errors
        }
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore release errors
    }
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))).toString("utf8");
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function parseProjectPayload(input: unknown):
  | {
      ok: true;
      value: ProjectPayload;
    }
  | {
      ok: false;
      error: { error: { code: string; message: string } };
    } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: errorResponse("invalid_project", "Project payload must be a JSON object.")
    };
  }

  if (!Object.hasOwn(input, "snapshot")) {
    return {
      ok: false,
      error: errorResponse("missing_snapshot", "Project payload must include a snapshot.")
    };
  }

  const snapshot = input.snapshot;
  if (snapshot !== null && (!isRecord(snapshot) || Array.isArray(snapshot))) {
    return {
      ok: false,
      error: errorResponse("invalid_snapshot", "Project snapshot must be an object or null.")
    };
  }

  const snapshotJson = JSON.stringify(snapshot);
  const snapshotBytes = snapshotJson ? Buffer.byteLength(snapshotJson, "utf8") : 0;
  if (!snapshotJson || snapshotBytes > MAX_PROJECT_SNAPSHOT_BYTES) {
    return {
      ok: false,
      error: errorResponse(
        "invalid_snapshot",
        `Project snapshot is too large (${formatBytes(snapshotBytes)}). Maximum is ${formatBytes(MAX_PROJECT_SNAPSHOT_BYTES)}.`
      )
    };
  }

  const name = input.name;
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_PROJECT_NAME_LENGTH) {
      return {
        ok: false,
        error: errorResponse("invalid_name", "Project name must be a non-empty string up to 120 characters.")
      };
    }

    return {
      ok: true,
      value: {
        name: name.trim(),
        snapshotJson
      }
    };
  }

  return {
    ok: true,
    value: {
      snapshotJson
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMainModule(): boolean {
  const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
  return entryUrl === import.meta.url;
}

if (isMainModule()) {
  // Await bootstrap (admin seed → interrupted-job recovery → drain pending queue)
  // BEFORE accepting any HTTP traffic. Otherwise an inbound request that lands
  // mid-recovery can have its newly-running job swept by recoverInterruptedJobs.
  await bootstrap();
  const server = serve(
    {
      fetch: app.fetch,
      hostname: serverConfig.host,
      port: serverConfig.port
    },
    (info) => {
      console.log(`API listening at http://${info.address}:${info.port}`);
    }
  );

  const shutdown = (): void => {
    closeDatabase();
    server.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
