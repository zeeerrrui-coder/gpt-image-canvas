import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parsePreviewWidth, readStoredAssetPreview } from "./asset-preview.js";
import {
  authenticateSessionToken,
  ensureBootstrapAdmin,
  listUsers,
  loginUser,
  logoutSessionToken,
  registerUser,
  SESSION_DURATION_SECONDS,
  type AppUser
} from "./auth-service.js";
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
  GENERATION_COUNTS,
  IMAGE_QUALITIES,
  MAX_REFERENCE_IMAGES,
  OUTPUT_FORMATS,
  PROVIDER_SOURCE_IDS,
  SIZE_PRESETS,
  STYLE_PRESETS,
  composePrompt,
  validateSceneImageSize,
  type AppConfig,
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
import { deleteGalleryOutput, getGalleryImages, getProjectState, saveProjectSnapshot } from "./project-store.js";
import { getProviderConfig, isProviderSourceOrder, saveProviderConfig } from "./provider-config.js";
import { runtimePaths, serverConfig } from "./runtime.js";
import { getStorageConfig, saveStorageConfig, testStorageConfig } from "./storage-config.js";

const MAX_PROJECT_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const MAX_PROJECT_NAME_LENGTH = 120;
const SESSION_COOKIE_NAME = "gic_session";

interface ProjectPayload {
  name?: string;
  snapshotJson: string;
}

export const app = new Hono();

void ensureBootstrapAdmin().catch((error) => {
  console.error("Admin bootstrap failed.", error);
});

app.onError((error, c) => {
  console.error(error);
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
    counts: GENERATION_COUNTS
  };

  return c.json(config);
});

app.post("/api/auth/register", async (c) => {
  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, 400);
  }

  const parsed = parseCredentialsPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    await registerUser(parsed.value);
    const session = await loginUser(parsed.value);
    setSessionCookie(c, session.token, session.expiresAt);
    return c.json({ user: session.user });
  } catch (error) {
    return c.json(errorResponse("auth_error", errorToMessage(error)), 400);
  }
});

app.post("/api/auth/login", async (c) => {
  await ensureBootstrapAdmin();

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, 400);
  }

  const parsed = parseCredentialsPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    const session = await loginUser(parsed.value);
    setSessionCookie(c, session.token, session.expiresAt);
    return c.json({ user: session.user });
  } catch (error) {
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

app.get("/api/admin/users", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  return c.json({
    users: listUsers()
  });
});

app.post("/api/admin/users/:userId/credits", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, 400);
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
    return c.json(payload.error, 400);
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
    return c.json(payload.error, 400);
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
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  return c.json(getStorageConfig());
});

app.put("/api/storage/config", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, 400);
  }

  const parsed = parseStorageConfigPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  try {
    return c.json(await saveStorageConfig(parsed.value));
  } catch (error) {
    return c.json(errorResponse("storage_config_error", errorToMessage(error)), 400);
  }
});

app.post("/api/storage/config/test", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin.ok) {
    return admin.response;
  }

  const payload = await readJson(c.req.raw);
  if (!payload.ok) {
    return c.json(payload.error, 400);
  }

  const parsed = parseStorageConfigPayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  return c.json(await testStorageConfig(parsed.value));
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

  const preview = await readStoredAssetPreview(c.req.param("id"), parsedWidth.width);
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
    return c.json(payload.error, 400);
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
    return c.json(payload.error, 400);
  }

  const parsed = parseGeneratePayload(payload.value);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  let reservedCount = 0;
  try {
    reserveGenerationCredits({
      userId: user.user.id,
      requestedCount: parsed.value.count
    });
    reservedCount = parsed.value.count;
    const provider = await createConfiguredImageProvider(c.req.raw.signal);
    const result = await runTextToImageGeneration(parsed.value, provider, user.user.id, c.req.raw.signal);
    const successfulCount = successfulOutputCount(result.record);
    const updatedUser = refundGenerationCredits({
      userId: user.user.id,
      generationId: result.record.id,
      amount: parsed.value.count - successfulCount
    });
    return c.json({ ...result, user: updatedUser });
  } catch (error) {
    if (reservedCount > 0) {
      refundGenerationCredits({
        userId: user.user.id,
        amount: reservedCount
      });
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
    return c.json(payload.error, 400);
  }

  const parsed = parseEditPayload(payload.value, user.user.id);
  if (!parsed.ok) {
    return c.json(parsed.error, 400);
  }

  let reservedCount = 0;
  try {
    reserveGenerationCredits({
      userId: user.user.id,
      requestedCount: parsed.value.count
    });
    reservedCount = parsed.value.count;
    const provider = await createConfiguredImageProvider(c.req.raw.signal);
    const result = await runReferenceImageGeneration(parsed.value, provider, user.user.id, c.req.raw.signal);
    const successfulCount = successfulOutputCount(result.record);
    const updatedUser = refundGenerationCredits({
      userId: user.user.id,
      generationId: result.record.id,
      amount: parsed.value.count - successfulCount
    });
    return c.json({ ...result, user: updatedUser });
  } catch (error) {
    if (reservedCount > 0) {
      refundGenerationCredits({
        userId: user.user.id,
        amount: reservedCount
      });
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
    sameSite: "Lax"
  });
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

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
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
