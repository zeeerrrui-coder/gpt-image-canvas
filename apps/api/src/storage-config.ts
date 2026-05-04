import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { SaveStorageConfigRequest, StorageConfigResponse, StorageTestResult } from "./contracts.js";
import { db } from "./database.js";
import { CosAssetStorageAdapter, normalizeKeyPrefix, type CosStorageAdapterConfig, storageErrorMessage } from "./asset-storage.js";
import { storageConfigs } from "./schema.js";

const DEFAULT_COS_BUCKET = process.env.COS_DEFAULT_BUCKET?.trim() || "";
const DEFAULT_COS_REGION = process.env.COS_DEFAULT_REGION?.trim() || "";
const DEFAULT_COS_KEY_PREFIX = process.env.COS_DEFAULT_KEY_PREFIX?.trim() || "gpt-image-canvas/assets";

type StorageConfigRow = typeof storageConfigs.$inferSelect;

export function getStorageConfig(userId: string): StorageConfigResponse {
  return toStorageConfigResponse(getStorageConfigRow(userId));
}

export function getActiveCosStorageConfigForUser(userId: string): CosStorageAdapterConfig | undefined {
  const row = getStorageConfigRow(userId);
  if (!row || row.enabled !== 1 || row.provider !== "cos" || !row.secretId || !row.secretKey || !row.bucket || !row.region) {
    return undefined;
  }
  return {
    secretId: row.secretId,
    secretKey: row.secretKey,
    bucket: row.bucket,
    region: row.region,
    keyPrefix: normalizeKeyPrefix(row.keyPrefix ?? DEFAULT_COS_KEY_PREFIX)
  };
}

export async function saveStorageConfig(userId: string, input: SaveStorageConfigRequest): Promise<StorageConfigResponse> {
  const now = new Date().toISOString();
  const existing = getStorageConfigRow(userId);

  if (!input.enabled) {
    upsertRow({
      id: existing?.id ?? randomUUID(),
      userId,
      provider: "cos",
      enabled: 0,
      secretId: existing?.secretId ?? null,
      secretKey: existing?.secretKey ?? null,
      bucket: existing?.bucket ?? DEFAULT_COS_BUCKET,
      region: existing?.region ?? DEFAULT_COS_REGION,
      keyPrefix: normalizeKeyPrefix(existing?.keyPrefix ?? DEFAULT_COS_KEY_PREFIX),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    return getStorageConfig(userId);
  }

  const parsed = resolveCosConfigForSave(input, existing);
  await new CosAssetStorageAdapter(parsed).testConfig();

  upsertRow({
    id: existing?.id ?? randomUUID(),
    userId,
    provider: "cos",
    enabled: 1,
    secretId: parsed.secretId,
    secretKey: parsed.secretKey,
    bucket: parsed.bucket,
    region: parsed.region,
    keyPrefix: parsed.keyPrefix,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });

  return getStorageConfig(userId);
}

export async function testStorageConfig(userId: string, input: SaveStorageConfigRequest): Promise<StorageTestResult> {
  try {
    const parsed = resolveCosConfigForSave(input, getStorageConfigRow(userId));
    await new CosAssetStorageAdapter(parsed).testConfig();
    return { ok: true, message: "COS configuration is available." };
  } catch (error) {
    return { ok: false, message: storageErrorMessage(error) };
  }
}

function getStorageConfigRow(userId: string): StorageConfigRow | undefined {
  return db.select().from(storageConfigs).where(eq(storageConfigs.userId, userId)).get();
}

function upsertRow(row: StorageConfigRow): void {
  const existing = db.select().from(storageConfigs).where(eq(storageConfigs.id, row.id)).get();
  if (existing) {
    db.update(storageConfigs)
      .set({
        userId: row.userId,
        provider: row.provider,
        enabled: row.enabled,
        secretId: row.secretId,
        secretKey: row.secretKey,
        bucket: row.bucket,
        region: row.region,
        keyPrefix: row.keyPrefix,
        updatedAt: row.updatedAt
      })
      .where(eq(storageConfigs.id, row.id))
      .run();
    return;
  }
  db.insert(storageConfigs).values(row).run();
}

function resolveCosConfigForSave(input: SaveStorageConfigRequest, existing: StorageConfigRow | undefined): CosStorageAdapterConfig {
  if (input.provider !== "cos") {
    throw new Error("Only Tencent COS storage is supported in this version.");
  }
  const cos = input.cos;
  if (!cos) {
    throw new Error("COS configuration is required.");
  }
  const secretId = requiredString(cos.secretId, "COS SecretId");
  const secretKey = cos.preserveSecret ? existing?.secretKey : cos.secretKey;
  const bucket = requiredString(cos.bucket, "COS bucket");
  const region = requiredString(cos.region, "COS region");
  if (!secretKey?.trim()) {
    throw new Error("COS SecretKey is required.");
  }
  return {
    secretId,
    secretKey: secretKey.trim(),
    bucket,
    region,
    keyPrefix: normalizeKeyPrefix(cos.keyPrefix)
  };
}

function requiredString(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function toStorageConfigResponse(row: StorageConfigRow | undefined): StorageConfigResponse {
  return {
    enabled: row?.enabled === 1,
    provider: "cos",
    cos: {
      secretId: row?.secretId ?? "",
      secretKey: {
        hasSecret: Boolean(row?.secretKey),
        value: row?.secretKey ? maskSecret(row.secretKey) : undefined
      },
      bucket: row?.bucket ?? DEFAULT_COS_BUCKET,
      region: row?.region ?? DEFAULT_COS_REGION,
      keyPrefix: normalizeKeyPrefix(row?.keyPrefix ?? DEFAULT_COS_KEY_PREFIX)
    }
  };
}

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 4)}${"*".repeat(Math.min(8, Math.max(4, value.length - 8)))}${value.slice(-4)}`;
}

// 启动时清理：旧的全局 storage_configs（user_id IS NULL）属于旧版本的 admin 全局配置，
// 现在每个用户独立，旧行直接清掉，让管理员重新到自己账户里配。
export function purgeLegacyGlobalStorageConfigs(): number {
  const result = db.delete(storageConfigs).where(and(isNull(storageConfigs.userId))).run();
  return result.changes;
}
