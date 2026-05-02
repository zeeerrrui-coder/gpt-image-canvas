import { eq } from "drizzle-orm";
import type {
  AuthStatusResponse,
  CodexDevicePollResponse,
  CodexDeviceStartResponse,
  CodexLogoutResponse
} from "./contracts.js";
import {
  CODEX_CLIENT_ID,
  classifyCodexRefreshFailure,
  parseCodexDevicePollPayload,
  parseCodexDeviceStartPayload,
  parseCodexTokenPayload
} from "./codex-auth-utils.js";
import { db } from "./database.js";
import { ProviderError } from "./image-provider.js";
import { getProviderConfig } from "./provider-config.js";
import { codexOAuthTokens } from "./schema.js";

const CODEX_TOKEN_ROW_ID = "default";
const DEFAULT_CODEX_ISSUER = "https://auth.openai.com";
const DEFAULT_CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CODEX_AUTH_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;

type CodexTokenRow = typeof codexOAuthTokens.$inferSelect;

export interface CodexAccessSession {
  accessToken: string;
  accountId?: string;
  expiresAt?: string;
}

export function getAuthStatus(): AuthStatusResponse {
  const providerConfig = getProviderConfig();
  const codex = providerConfig.sources.find((source) => source.id === "codex")?.details.codex ?? codexSessionView(getCodexTokenRow());
  const openaiConfigured = providerConfig.sources.some(
    (source) => (source.id === "env-openai" || source.id === "local-openai") && source.available
  );

  return {
    provider: providerConfig.activeSource?.provider ?? "none",
    openaiConfigured,
    codex,
    activeSource: providerConfig.activeSource
  };
}

export function getCodexResponsesBaseURL(): string {
  return trimTrailingSlash(process.env.CODEX_RESPONSES_BASE_URL?.trim() || DEFAULT_CODEX_RESPONSES_BASE_URL);
}

export async function startCodexDeviceLogin(signal?: AbortSignal): Promise<CodexDeviceStartResponse> {
  const issuer = getCodexIssuer();
  const response = await fetchJson(
    `${issuer}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: CODEX_CLIENT_ID
      })
    },
    signal
  );

  const parsed = parseCodexDeviceStartPayload(response, {
    verificationUrl: `${issuer}/codex/device`
  });

  if (!parsed) {
    throw new ProviderError("unsupported_provider_behavior", "Codex 登录服务返回内容无法识别。", 502);
  }

  return parsed;
}

export async function pollCodexDeviceLogin(
  input: {
    deviceAuthId: string;
    userCode: string;
  },
  signal?: AbortSignal
): Promise<CodexDevicePollResponse> {
  const issuer = getCodexIssuer();
  const timeout = timeoutSignal(signal, authTimeoutMs());
  const response = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      device_auth_id: input.deviceAuthId,
      user_code: input.userCode
    }),
    signal: timeout.signal
  })
    .catch((error: unknown) => {
      throw fetchFailureToProviderError(error, "Codex 登录服务暂时不可用。");
    })
    .finally(timeout.cleanup);

  const body = await readResponseBody(response);
  const parsed = parseCodexDevicePollPayload(response.status, body);

  if (parsed.status === "pending") {
    return {
      status: "pending",
      interval: parsed.interval
    };
  }

  if (parsed.status === "expired" || parsed.status === "denied") {
    return {
      status: parsed.status,
      message: parsed.message
    };
  }

  if (parsed.status === "error") {
    throw new ProviderError("upstream_failure", parsed.message, providerHttpStatus(response.status));
  }

  if (parsed.status !== "authorized") {
    throw new ProviderError("upstream_failure", "Codex 登录轮询失败，请稍后重试。", providerHttpStatus(response.status));
  }

  const tokens = await exchangeAuthorizationCodeForTokens(issuer, parsed.exchange.authorizationCode, parsed.exchange.codeVerifier, signal);
  storeCodexTokens(tokens);

  return {
    status: "authorized",
    auth: getAuthStatus()
  };
}

export function logoutCodex(): CodexLogoutResponse {
  db.delete(codexOAuthTokens).where(eq(codexOAuthTokens.id, CODEX_TOKEN_ROW_ID)).run();

  return {
    ok: true,
    auth: getAuthStatus()
  };
}

export async function getValidCodexSession(signal?: AbortSignal): Promise<CodexAccessSession | undefined> {
  const row = getCodexTokenRow();
  if (!hasUsableTokenMaterial(row)) {
    return undefined;
  }

  const sessionRow = shouldRefreshCodexToken(row) ? await refreshCodexToken(row, signal) : row;
  if (!hasUsableTokenMaterial(sessionRow)) {
    return undefined;
  }

  return {
    accessToken: sessionRow.accessToken,
    accountId: sessionRow.accountId ?? undefined,
    expiresAt: sessionRow.expiresAt ?? undefined
  };
}

function getCodexTokenRow(): CodexTokenRow | undefined {
  return db.select().from(codexOAuthTokens).where(eq(codexOAuthTokens.id, CODEX_TOKEN_ROW_ID)).get();
}

function storeCodexTokens(payload: unknown, fallback?: CodexTokenRow): CodexTokenRow {
  const now = new Date();
  const parsed = parseCodexTokenPayload(payload, {
    now,
    fallback: fallback
      ? {
          accessToken: fallback.accessToken,
          refreshToken: fallback.refreshToken,
          idToken: fallback.idToken,
          email: fallback.email,
          accountId: fallback.accountId,
          expiresAt: fallback.expiresAt
        }
      : undefined
  });

  if (!parsed) {
    throw new ProviderError("unsupported_provider_behavior", "Codex 登录服务没有返回完整令牌。", 502);
  }

  const createdAt = fallback?.createdAt ?? now.toISOString();
  const row: CodexTokenRow = {
    id: CODEX_TOKEN_ROW_ID,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    idToken: parsed.idToken,
    email: parsed.email ?? null,
    accountId: parsed.accountId ?? null,
    expiresAt: parsed.expiresAt,
    refreshedAt: parsed.refreshedAt,
    unavailableAt: null,
    unavailableReason: null,
    createdAt,
    updatedAt: now.toISOString()
  };

  db.insert(codexOAuthTokens)
    .values(row)
    .onConflictDoUpdate({
      target: codexOAuthTokens.id,
      set: {
        accessToken: row.accessToken,
        refreshToken: row.refreshToken,
        idToken: row.idToken,
        email: row.email,
        accountId: row.accountId,
        expiresAt: row.expiresAt,
        refreshedAt: row.refreshedAt,
        unavailableAt: row.unavailableAt,
        unavailableReason: row.unavailableReason,
        updatedAt: row.updatedAt
      }
    })
    .run();

  return row;
}

async function refreshCodexToken(row: CodexTokenRow, signal?: AbortSignal): Promise<CodexTokenRow | undefined> {
  if (!row.refreshToken) {
    markCodexSessionUnavailable("missing_refresh_token");
    return undefined;
  }

  const timeout = timeoutSignal(signal, authTimeoutMs());
  const response = await fetch(getCodexRefreshTokenURL(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: row.refreshToken
    }),
    signal: timeout.signal
  })
    .catch((error: unknown) => {
      throw fetchFailureToProviderError(error, "Codex 登录刷新失败，请稍后重试。");
    })
    .finally(timeout.cleanup);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (classifyCodexRefreshFailure(response.status, body) === "permanent") {
      markCodexSessionUnavailable("refresh_rejected");
      return undefined;
    }

    throw new ProviderError("upstream_failure", "Codex 登录刷新失败，请稍后重试。", providerHttpStatus(response.status));
  }

  const payload = await response.json().catch(() => undefined);
  return storeCodexTokens(payload, row);
}

async function exchangeAuthorizationCodeForTokens(
  issuer: string,
  authorizationCode: string,
  codeVerifier: string,
  signal?: AbortSignal
): Promise<unknown> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: `${issuer}/deviceauth/callback`,
    client_id: CODEX_CLIENT_ID,
    code_verifier: codeVerifier
  });

  const timeout = timeoutSignal(signal, authTimeoutMs());
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    signal: timeout.signal
  })
    .catch((error: unknown) => {
      throw fetchFailureToProviderError(error, "Codex 登录换取令牌失败。");
    })
    .finally(timeout.cleanup);

  if (!response.ok) {
    throw new ProviderError("upstream_failure", "Codex 登录换取令牌失败。", providerHttpStatus(response.status));
  }

  return response.json().catch(() => {
    throw new ProviderError("unsupported_provider_behavior", "Codex 登录令牌响应无法解析。", 502);
  });
}

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const timeout = timeoutSignal(signal, authTimeoutMs());
  try {
    const response = await fetch(url, {
      ...init,
      signal: timeout.signal
    }).catch((error: unknown) => {
      throw fetchFailureToProviderError(error, "Codex 登录服务暂时不可用。");
    });

    if (!response.ok) {
      throw new ProviderError("upstream_failure", "Codex 登录服务请求失败。", providerHttpStatus(response.status));
    }

    return response.json().catch(() => {
      throw new ProviderError("unsupported_provider_behavior", "Codex 登录服务响应无法解析。", 502);
    });
  } finally {
    timeout.cleanup();
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => undefined);
  }

  return response.text().catch(() => "");
}

function markCodexSessionUnavailable(reason: string): void {
  const now = new Date().toISOString();
  db.update(codexOAuthTokens)
    .set({
      accessToken: null,
      refreshToken: null,
      idToken: null,
      unavailableAt: now,
      unavailableReason: reason,
      updatedAt: now
    })
    .where(eq(codexOAuthTokens.id, CODEX_TOKEN_ROW_ID))
    .run();
}

function codexSessionView(row: CodexTokenRow | undefined): AuthStatusResponse["codex"] {
  const available = hasUsableTokenMaterial(row);

  return {
    available,
    email: row?.email ?? undefined,
    accountId: row?.accountId ?? undefined,
    expiresAt: row?.expiresAt ?? undefined,
    refreshedAt: row?.refreshedAt ?? undefined,
    unavailableReason: !available ? (row?.unavailableReason ?? undefined) : undefined
  };
}

function hasUsableTokenMaterial(row: CodexTokenRow | undefined): row is CodexTokenRow & {
  accessToken: string;
  refreshToken: string;
} {
  return Boolean(row?.accessToken && row.refreshToken && !row.unavailableAt);
}

function shouldRefreshCodexToken(row: CodexTokenRow): boolean {
  if (!row.expiresAt) {
    return true;
  }

  const expiresAt = Date.parse(row.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS) {
    return true;
  }

  if (!row.refreshedAt) {
    return true;
  }

  const refreshedAt = Date.parse(row.refreshedAt);
  return !Number.isFinite(refreshedAt) || Date.now() - refreshedAt >= TOKEN_REFRESH_INTERVAL_MS;
}

function getCodexIssuer(): string {
  return trimTrailingSlash(process.env.CODEX_AUTH_ISSUER?.trim() || DEFAULT_CODEX_ISSUER);
}

function getCodexRefreshTokenURL(): string {
  return process.env.CODEX_REFRESH_TOKEN_URL?.trim() || `${getCodexIssuer()}/oauth/token`;
}

function authTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.CODEX_AUTH_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_AUTH_TIMEOUT_MS;
}

function providerHttpStatus(status: number | undefined): number {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function fetchFailureToProviderError(error: unknown, message: string): ProviderError | Error {
  if (isAbortError(error)) {
    return new ProviderError("upstream_failure", message, 504);
  }

  return new ProviderError("upstream_failure", message, 502);
}

function isAbortError(error: unknown): error is Error {
  return error instanceof DOMException && error.name === "AbortError";
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);

  if (signal?.aborted) {
    abort();
  } else if (signal) {
    signal.addEventListener("abort", abort, { once: true });
  }

  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}
