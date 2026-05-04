import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

const MAX_FAILED_ATTEMPTS = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCK_DURATION_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const TRUST_PROXY_TRUE_VALUES = new Set(["true", "1", "yes", "on"]);

interface AttemptRecord {
  failureCount: number;
  windowStartAt: number;
  lockedUntil?: number;
}

const attemptsByKey = new Map<string, AttemptRecord>();
let lastSweepAt = 0;

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export function checkAuthRateLimit(c: Context): RateLimitVerdict {
  sweepIfDue();
  const key = clientKey(c);
  if (!key) {
    return { allowed: true };
  }

  const record = attemptsByKey.get(key);
  if (!record) {
    return { allowed: true };
  }

  const now = Date.now();
  if (record.lockedUntil && record.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((record.lockedUntil - now) / 1000)
    };
  }

  if (record.lockedUntil && record.lockedUntil <= now) {
    attemptsByKey.delete(key);
  }

  return { allowed: true };
}

export function recordAuthFailure(c: Context): void {
  const key = clientKey(c);
  if (!key) {
    return;
  }

  const now = Date.now();
  const existing = attemptsByKey.get(key);
  if (!existing || now - existing.windowStartAt > FAILURE_WINDOW_MS) {
    attemptsByKey.set(key, {
      failureCount: 1,
      windowStartAt: now
    });
    return;
  }

  existing.failureCount += 1;
  if (existing.failureCount >= MAX_FAILED_ATTEMPTS) {
    existing.lockedUntil = now + LOCK_DURATION_MS;
  }
}

export function clearAuthFailures(c: Context): void {
  const key = clientKey(c);
  if (!key) {
    return;
  }
  attemptsByKey.delete(key);
}

function clientKey(c: Context): string | undefined {
  const socketIp = socketRemoteAddress(c);
  if (!trustProxyHeaders()) {
    return socketIp;
  }

  return proxyHeaderClientIp(c) ?? socketIp;
}

function proxyHeaderClientIp(c: Context): string | undefined {
  const cfIp = c.req.header("cf-connecting-ip")?.trim();
  if (cfIp) {
    return cfIp;
  }

  const forwardedFor = c.req.header("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }

  return undefined;
}

function socketRemoteAddress(c: Context): string | undefined {
  try {
    const address = getConnInfo(c).remote.address?.trim();
    return address || undefined;
  } catch {
    return undefined;
  }
}

function trustProxyHeaders(): boolean {
  const value = process.env.TRUST_PROXY_HEADERS?.trim().toLowerCase();
  return value ? TRUST_PROXY_TRUE_VALUES.has(value) : false;
}

function sweepIfDue(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) {
    return;
  }

  lastSweepAt = now;
  for (const [key, record] of attemptsByKey) {
    if (record.lockedUntil && record.lockedUntil <= now) {
      attemptsByKey.delete(key);
      continue;
    }
    if (now - record.windowStartAt > FAILURE_WINDOW_MS) {
      attemptsByKey.delete(key);
    }
  }
}

export const authRateLimitTesting = {
  reset(): void {
    attemptsByKey.clear();
    lastSweepAt = 0;
  }
};
