import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "./database.js";
import { runtimePaths } from "./runtime.js";
import {
  creditTransactions,
  errorLogs,
  generationOutputs,
  imageGenerationJobs,
  redeemCodes,
  sessions,
  users
} from "./schema.js";

export interface AdminStats {
  totalUsers: number;
  activeUsersLast7d: number;
  totalGenerations: number;
  generationsLast7d: number;
  totalFailedJobs: number;
  totalSucceededOutputs: number;
  totalFailedOutputs: number;
  totalCreditsGranted: number;
  totalCreditsConsumed: number;
  totalRedeemCodes: number;
  totalErrors24h: number;
  diskUsageBytes: number;
}

export function getAdminStats(): AdminStats {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const totalUsers = scalar(db.select({ value: count() }).from(users).get());
  const activeUsersLast7d = scalar(
    db
      .select({ value: sql<number>`COUNT(DISTINCT ${sessions.userId})` })
      .from(sessions)
      .where(gte(sessions.createdAt, since7d))
      .get()
  );
  const totalGenerations = scalar(db.select({ value: count() }).from(imageGenerationJobs).get());
  const generationsLast7d = scalar(
    db.select({ value: count() }).from(imageGenerationJobs).where(gte(imageGenerationJobs.createdAt, since7d)).get()
  );
  const totalFailedJobs = scalar(
    db
      .select({ value: count() })
      .from(imageGenerationJobs)
      .where(and(inArray(imageGenerationJobs.status, ["failed", "cancelled"])))
      .get()
  );
  const totalSucceededOutputs = scalar(
    db.select({ value: count() }).from(generationOutputs).where(eq(generationOutputs.status, "succeeded")).get()
  );
  const totalFailedOutputs = scalar(
    db.select({ value: count() }).from(generationOutputs).where(eq(generationOutputs.status, "failed")).get()
  );
  const grantedRow = db
    .select({ value: sql<number>`COALESCE(SUM(${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .where(sql`${creditTransactions.amount} > 0`)
    .get();
  const consumedRow = db
    .select({ value: sql<number>`COALESCE(SUM(-${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .where(sql`${creditTransactions.amount} < 0`)
    .get();
  const totalRedeemCodes = scalar(db.select({ value: count() }).from(redeemCodes).get());
  const totalErrors24h = scalar(
    db.select({ value: count() }).from(errorLogs).where(gte(errorLogs.createdAt, since24h)).get()
  );

  return {
    totalUsers,
    activeUsersLast7d,
    totalGenerations,
    generationsLast7d,
    totalFailedJobs,
    totalSucceededOutputs,
    totalFailedOutputs,
    totalCreditsGranted: scalar(grantedRow),
    totalCreditsConsumed: scalar(consumedRow),
    totalRedeemCodes,
    totalErrors24h,
    diskUsageBytes: estimateDiskUsage()
  };
}

function scalar(row: { value: number } | undefined): number {
  return row?.value ?? 0;
}

function estimateDiskUsage(): number {
  let total = 0;
  for (const dir of [runtimePaths.assetsDir, runtimePaths.assetPreviewsDir]) {
    total += dirSize(dir);
  }
  try {
    total += statSync(runtimePaths.databaseFile).size;
  } catch {
    // ignore
  }
  return total;
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      try {
        if (entry.isFile()) {
          total += statSync(path).size;
        } else if (entry.isDirectory()) {
          total += dirSize(path);
        }
      } catch {
        // ignore individual file errors
      }
    }
  } catch {
    // ignore directory missing
  }
  return total;
}

export interface ErrorLogEntry {
  id: string;
  path: string;
  method: string;
  status: number | null;
  code: string | null;
  message: string;
  userId: string | null;
  createdAt: string;
}

export interface ErrorLogPage {
  items: ErrorLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export function listErrorLogs(options: { page?: number; pageSize?: number } = {}): ErrorLogPage {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 30)));

  const totalRow = db.select({ value: count() }).from(errorLogs).get();
  const total = totalRow?.value ?? 0;

  const items = db
    .select()
    .from(errorLogs)
    .orderBy(sql`${errorLogs.createdAt} DESC`)
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  return {
    items: items.map((row) => ({
      id: row.id,
      path: row.path,
      method: row.method,
      status: row.status,
      code: row.code,
      message: row.message,
      userId: row.userId,
      createdAt: row.createdAt
    })),
    total,
    page,
    pageSize
  };
}

export function recordErrorLog(input: { path: string; method: string; status: number | null; code: string | null; message: string; userId: string | null }): void {
  try {
    db.insert(errorLogs)
      .values({
        id: randomLogId(),
        path: input.path.slice(0, 200),
        method: input.method.slice(0, 16),
        status: input.status,
        code: input.code?.slice(0, 64) ?? null,
        message: input.message.slice(0, 800),
        userId: input.userId,
        createdAt: new Date().toISOString()
      })
      .run();
  } catch {
    // logging failure must not bubble up
  }
}

function randomLogId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
