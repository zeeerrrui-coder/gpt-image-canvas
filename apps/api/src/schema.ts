import { relations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  nickname: text("nickname"),
  role: text("role").notNull(),
  status: text("status").notNull(),
  credits: integer("credits").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull()
});

export const creditTransactions = sqliteTable("credit_transactions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  amount: integer("amount").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  generationId: text("generation_id"),
  adminId: text("admin_id").references(() => users.id),
  note: text("note"),
  createdAt: text("created_at").notNull()
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  relativePath: text("relative_path").notNull(),
  mimeType: text("mime_type").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  cloudProvider: text("cloud_provider"),
  cloudBucket: text("cloud_bucket"),
  cloudRegion: text("cloud_region"),
  cloudObjectKey: text("cloud_object_key"),
  cloudStatus: text("cloud_status"),
  cloudError: text("cloud_error"),
  cloudUploadedAt: text("cloud_uploaded_at"),
  cloudEtag: text("cloud_etag"),
  cloudRequestId: text("cloud_request_id"),
  createdAt: text("created_at").notNull()
});

export const storageConfigs = sqliteTable("storage_configs", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  enabled: integer("enabled").notNull(),
  secretId: text("secret_id"),
  secretKey: text("secret_key"),
  bucket: text("bucket"),
  region: text("region"),
  keyPrefix: text("key_prefix"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const providerConfigs = sqliteTable("provider_configs", {
  id: text("id").primaryKey(),
  sourceOrderJson: text("source_order_json").notNull(),
  localApiKey: text("local_api_key"),
  localBaseUrl: text("local_base_url"),
  localModel: text("local_model"),
  localTimeoutMs: integer("local_timeout_ms"),
  activeProfileId: text("active_profile_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const redeemCodes = sqliteTable("redeem_codes", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  credits: integer("credits").notNull(),
  maxUses: integer("max_uses").notNull(),
  usesCount: integer("uses_count").notNull(),
  expiresAt: text("expires_at"),
  note: text("note"),
  adminId: text("admin_id").references(() => users.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const redeemCodeUses = sqliteTable("redeem_code_uses", {
  id: text("id").primaryKey(),
  codeId: text("code_id").notNull().references(() => redeemCodes.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  credits: integer("credits").notNull(),
  createdAt: text("created_at").notNull()
});

export const imageGenerationJobs = sqliteTable("image_generation_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  inputJson: text("input_json").notNull(),
  reservedAmount: integer("reserved_amount").notNull(),
  creditPerImage: integer("credit_per_image").notNull(),
  generationRecordId: text("generation_record_id").references(() => generationRecords.id, { onDelete: "set null" }),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const errorLogs = sqliteTable("error_logs", {
  id: text("id").primaryKey(),
  path: text("path").notNull(),
  method: text("method").notNull(),
  status: integer("status"),
  code: text("code"),
  message: text("message").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull()
});

export const providerLocalProfiles = sqliteTable("provider_local_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiKey: text("api_key").notNull(),
  baseUrl: text("base_url"),
  model: text("model"),
  timeoutMs: integer("timeout_ms"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const codexOAuthTokens = sqliteTable("codex_oauth_tokens", {
  id: text("id").primaryKey(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  email: text("email"),
  accountId: text("account_id"),
  expiresAt: text("expires_at"),
  refreshedAt: text("refreshed_at"),
  unavailableAt: text("unavailable_at"),
  unavailableReason: text("unavailable_reason"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const generationRecords = sqliteTable("generation_records", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  prompt: text("prompt").notNull(),
  effectivePrompt: text("effective_prompt").notNull(),
  presetId: text("preset_id").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  quality: text("quality").notNull(),
  outputFormat: text("output_format").notNull(),
  count: integer("count").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  referenceAssetId: text("reference_asset_id").references(() => assets.id),
  createdAt: text("created_at").notNull()
});

export const generationOutputs = sqliteTable("generation_outputs", {
  id: text("id").primaryKey(),
  generationId: text("generation_id")
    .notNull()
    .references(() => generationRecords.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  assetId: text("asset_id").references(() => assets.id),
  error: text("error"),
  createdAt: text("created_at").notNull()
});

export const generationReferenceAssets = sqliteTable("generation_reference_assets", {
  generationId: text("generation_id")
    .notNull()
    .references(() => generationRecords.id, { onDelete: "cascade" }),
  assetId: text("asset_id")
    .notNull()
    .references(() => assets.id),
  position: integer("position").notNull(),
  createdAt: text("created_at").notNull()
});

export const generationRelations = relations(generationRecords, ({ many, one }) => ({
  outputs: many(generationOutputs),
  referenceAssets: many(generationReferenceAssets),
  referenceAsset: one(assets, {
    fields: [generationRecords.referenceAssetId],
    references: [assets.id]
  })
}));

export const outputRelations = relations(generationOutputs, ({ one }) => ({
  generation: one(generationRecords, {
    fields: [generationOutputs.generationId],
    references: [generationRecords.id]
  }),
  asset: one(assets, {
    fields: [generationOutputs.assetId],
    references: [assets.id]
  })
}));

export const referenceAssetRelations = relations(generationReferenceAssets, ({ one }) => ({
  generation: one(generationRecords, {
    fields: [generationReferenceAssets.generationId],
    references: [generationRecords.id]
  }),
  asset: one(assets, {
    fields: [generationReferenceAssets.assetId],
    references: [assets.id]
  })
}));
