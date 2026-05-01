import type {
  CodexDeviceStartResponse,
  RuntimeImageProvider
} from "./contracts.js";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const DEFAULT_DEVICE_LOGIN_EXPIRES_IN_SECONDS = 15 * 60;
const DEFAULT_DEVICE_LOGIN_INTERVAL_SECONDS = 5;
const FALLBACK_ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export interface ParsedCodexJwtClaims {
  email?: string;
  accountId?: string;
  expiresAt?: string;
  accountIsFedramp?: boolean;
}

export interface CodexTokenFallback {
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  email?: string | null;
  accountId?: string | null;
  expiresAt?: string | null;
}

export interface ParsedCodexTokenData {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  email?: string;
  accountId?: string;
  expiresAt: string;
  refreshedAt: string;
}

export interface CodexDeviceCodeExchange {
  authorizationCode: string;
  codeChallenge: string;
  codeVerifier: string;
}

export type CodexDevicePollParseResult =
  | {
      status: "authorized";
      exchange: CodexDeviceCodeExchange;
    }
  | {
      status: "pending";
      interval?: number;
    }
  | {
      status: "expired" | "denied" | "error";
      message: string;
      interval?: number;
    };

export type CodexRefreshFailureKind = "permanent" | "transient";

export function selectImageProviderName(input: {
  openaiApiKey?: string | null;
  codexSessionAvailable: boolean;
}): RuntimeImageProvider {
  if (input.openaiApiKey?.trim()) {
    return "openai";
  }

  return input.codexSessionAvailable ? "codex" : "none";
}

export function parseCodexJwtClaims(jwt: string): ParsedCodexJwtClaims | undefined {
  const payload = decodeJwtPayload(jwt);
  if (!payload) {
    return undefined;
  }

  const profile = objectValue(payload["https://api.openai.com/profile"]);
  const auth = objectValue(payload["https://api.openai.com/auth"]);
  const email = stringValue(payload.email) ?? stringValue(profile?.email);
  const expiresAt = dateFromUnixSeconds(payload.exp);

  return {
    email,
    accountId: stringValue(auth?.chatgpt_account_id),
    accountIsFedramp: auth?.chatgpt_account_is_fedramp === true,
    expiresAt
  };
}

export function parseCodexTokenPayload(
  payload: unknown,
  options: {
    fallback?: CodexTokenFallback;
    now?: Date;
  } = {}
): ParsedCodexTokenData | undefined {
  const record = objectValue(payload);
  if (!record) {
    return undefined;
  }

  const fallback = options.fallback;
  const accessToken = stringValue(record.access_token) ?? trimToUndefined(fallback?.accessToken);
  const refreshToken = stringValue(record.refresh_token) ?? trimToUndefined(fallback?.refreshToken);
  const idToken = stringValue(record.id_token) ?? trimToUndefined(fallback?.idToken);

  if (!accessToken || !refreshToken || !idToken) {
    return undefined;
  }

  const now = options.now ?? new Date();
  const idClaims = parseCodexJwtClaims(idToken);
  const accessClaims = parseCodexJwtClaims(accessToken);
  const expiresAt =
    accessClaims?.expiresAt ??
    dateFromExpiresIn(record.expires_in, now) ??
    trimToUndefined(fallback?.expiresAt) ??
    new Date(now.getTime() + FALLBACK_ACCESS_TOKEN_LIFETIME_MS).toISOString();

  return {
    accessToken,
    refreshToken,
    idToken,
    email: idClaims?.email ?? trimToUndefined(fallback?.email),
    accountId: stringValue(record.account_id) ?? idClaims?.accountId ?? trimToUndefined(fallback?.accountId),
    expiresAt,
    refreshedAt: now.toISOString()
  };
}

export function parseCodexDeviceStartPayload(
  payload: unknown,
  options: {
    verificationUrl: string;
    now?: Date;
  }
): CodexDeviceStartResponse | undefined {
  const record = objectValue(payload);
  if (!record) {
    return undefined;
  }

  const deviceAuthId = stringValue(record.device_auth_id) ?? stringValue(record.deviceAuthId);
  const userCode = stringValue(record.user_code) ?? stringValue(record.usercode) ?? stringValue(record.userCode);

  if (!deviceAuthId || !userCode) {
    return undefined;
  }

  const now = options.now ?? new Date();
  const interval = parsePositiveInteger(record.interval) ?? DEFAULT_DEVICE_LOGIN_INTERVAL_SECONDS;
  const expiresIn = parsePositiveInteger(record.expires_in) ?? DEFAULT_DEVICE_LOGIN_EXPIRES_IN_SECONDS;

  return {
    deviceAuthId,
    userCode,
    verificationUrl: options.verificationUrl,
    interval,
    expiresIn,
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString()
  };
}

export function parseCodexDevicePollPayload(httpStatus: number, payload: unknown): CodexDevicePollParseResult {
  const record = objectValue(payload);
  const errorCode = errorCodeFromPayload(record);
  const interval = parsePositiveInteger(record?.interval);

  if (httpStatus === 200) {
    const authorizationCode = stringValue(record?.authorization_code) ?? stringValue(record?.authorizationCode);
    const codeChallenge = stringValue(record?.code_challenge) ?? stringValue(record?.codeChallenge);
    const codeVerifier = stringValue(record?.code_verifier) ?? stringValue(record?.codeVerifier);

    if (authorizationCode && codeChallenge && codeVerifier) {
      return {
        status: "authorized",
        exchange: {
          authorizationCode,
          codeChallenge,
          codeVerifier
        }
      };
    }

    return {
      status: "error",
      message: "Codex 登录服务返回内容无法识别。"
    };
  }

  if (errorCode === "authorization_pending" || httpStatus === 403 || httpStatus === 404) {
    return {
      status: "pending",
      interval
    };
  }

  if (errorCode === "slow_down") {
    return {
      status: "pending",
      interval: interval ? interval + 2 : undefined
    };
  }

  if (errorCode === "expired_token") {
    return {
      status: "expired",
      message: "Codex 登录码已过期，请重新开始登录。"
    };
  }

  if (errorCode === "access_denied") {
    return {
      status: "denied",
      message: "Codex 登录已被取消。"
    };
  }

  return {
    status: "error",
    message: "Codex 登录轮询失败，请稍后重试。"
  };
}

export function classifyCodexRefreshFailure(httpStatus: number, body: string): CodexRefreshFailureKind {
  if (httpStatus !== 400 && httpStatus !== 401) {
    return "transient";
  }

  const code = extractRefreshErrorCode(body);
  if (
    code === "invalid_grant" ||
    code === "refresh_token_expired" ||
    code === "refresh_token_reused" ||
    code === "refresh_token_invalidated"
  ) {
    return "permanent";
  }

  return httpStatus === 401 ? "permanent" : "transient";
}

function extractRefreshErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    const record = objectValue(parsed);
    return errorCodeFromPayload(record);
  } catch {
    return undefined;
  }
}

function errorCodeFromPayload(record: Record<string, unknown> | undefined): string | undefined {
  const rawCode = stringValue(record?.code) ?? stringValue(record?.error);
  return rawCode?.toLowerCase();
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 3 || !parts[1]) {
    return undefined;
  }

  try {
    return objectValue(JSON.parse(Buffer.from(toPaddedBase64(parts[1]), "base64").toString("utf8")));
  } catch {
    return undefined;
  }
}

function toPaddedBase64(value: string): string {
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = base64.length % 4;
  return padding === 0 ? base64 : `${base64}${"=".repeat(4 - padding)}`;
}

function dateFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function dateFromExpiresIn(value: unknown, now: Date): string | undefined {
  const expiresIn = parsePositiveInteger(value);
  return expiresIn ? new Date(now.getTime() + expiresIn * 1000).toISOString() : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
