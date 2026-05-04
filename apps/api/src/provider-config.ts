import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  IMAGE_MODEL,
  PROVIDER_SOURCE_IDS,
  type CodexAuthSessionView,
  type LocalOpenAIProfile,
  type LocalOpenAIProviderConfigView,
  type MaskedSecret,
  type ProviderConfigResponse,
  type ProviderSourceId,
  type ProviderSourceSummary,
  type ProviderSourceView,
  type RuntimeImageProvider,
  type SaveProviderConfigRequest
} from "./contracts.js";
import { db } from "./database.js";
import {
  DEFAULT_OPENAI_IMAGE_TIMEOUT_MS,
  getConfiguredImageModel,
  parseOpenAIImageTimeoutMs,
  type OpenAIImageProviderConfig
} from "./image-provider.js";
import { codexOAuthTokens, providerConfigs, providerLocalProfiles } from "./schema.js";

const ACTIVE_PROVIDER_CONFIG_ID = "active";
const CODEX_TOKEN_ROW_ID = "default";

export const DEFAULT_PROVIDER_SOURCE_ORDER: ProviderSourceId[] = ["env-openai", "local-openai", "codex"];

type ProviderConfigRow = typeof providerConfigs.$inferSelect;
type ProviderLocalProfileRow = typeof providerLocalProfiles.$inferSelect;
type CodexTokenRow = typeof codexOAuthTokens.$inferSelect;

export interface CreateLocalProfileInput {
  name: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export interface UpdateLocalProfileInput {
  name?: string;
  apiKey?: string;
  preserveApiKey?: boolean;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export interface LocalOpenAIProfileRecord {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string | null;
  model: string | null;
  timeoutMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export function getProviderConfig(): ProviderConfigResponse {
  const row = getProviderConfigRow();
  const sourceOrder = readSavedSourceOrder(row?.sourceOrderJson);
  const localProfiles = listLocalProfiles();
  const activeProfile = getActiveLocalProfile(row);
  const sourcesById = new Map(providerSources(activeProfile).map((source) => [source.id, source]));
  const sources = sourceOrder.map((sourceId) => sourcesById.get(sourceId)).filter(isDefined);
  const activeSource = sources.find((source) => source.available);

  return {
    sourceOrder,
    sources,
    localOpenAI: localOpenAIConfigView(activeProfile),
    localProfiles,
    activeProfileId: activeProfile?.id ?? null,
    activeSource: activeSource ? providerSourceSummary(activeSource) : undefined
  };
}

export function saveProviderConfig(input: SaveProviderConfigRequest): ProviderConfigResponse {
  if (!isProviderSourceOrder(input.sourceOrder)) {
    throw new Error("Provider source order is invalid.");
  }

  const now = new Date().toISOString();
  const existing = getProviderConfigRow();
  const activeProfileId = resolveActiveProfileIdForSave(input.localOpenAI, existing?.activeProfileId ?? null);

  db.transaction((tx) => {
    if (activeProfileId && !tx.select().from(providerLocalProfiles).where(eq(providerLocalProfiles.id, activeProfileId)).get()) {
      throw new Error("Local OpenAI profile not found.");
    }

    tx.insert(providerConfigs)
      .values({
        id: ACTIVE_PROVIDER_CONFIG_ID,
        sourceOrderJson: JSON.stringify(input.sourceOrder),
        localApiKey: existing?.localApiKey ?? null,
        localBaseUrl: existing?.localBaseUrl ?? null,
        localModel: existing?.localModel ?? null,
        localTimeoutMs: existing?.localTimeoutMs ?? null,
        activeProfileId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: providerConfigs.id,
        set: {
          sourceOrderJson: JSON.stringify(input.sourceOrder),
          activeProfileId,
          updatedAt: now
        }
      })
      .run();
  });

  return getProviderConfig();
}

export function getProviderSourceOrder(): ProviderSourceId[] {
  return readSavedSourceOrder(getProviderConfigRow()?.sourceOrderJson);
}

export function getEnvironmentOpenAIImageProviderConfig(): OpenAIImageProviderConfig | undefined {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }

  const baseURL = process.env.OPENAI_BASE_URL?.trim();
  return {
    apiKey,
    baseURL: baseURL || undefined,
    model: getConfiguredImageModel(),
    timeoutMs: parseOpenAIImageTimeoutMs(process.env.OPENAI_IMAGE_TIMEOUT_MS)
  };
}

export function getLocalOpenAIImageProviderConfig(): OpenAIImageProviderConfig | undefined {
  return localProfileToOpenAIConfig(getActiveLocalProfile());
}

export function listLocalProfiles(): LocalOpenAIProfile[] {
  return db
    .select()
    .from(providerLocalProfiles)
    .orderBy(asc(providerLocalProfiles.createdAt))
    .all()
    .map(localProfileView);
}

export function createLocalProfile(input: CreateLocalProfileInput): LocalOpenAIProfile {
  const name = requiredProfileName(input.name);
  const apiKey = requiredApiKey(input.apiKey);
  const now = new Date().toISOString();
  const profileId = randomUUID();
  let created: ProviderLocalProfileRow | undefined;

  db.transaction((tx) => {
    const duplicate = tx.select().from(providerLocalProfiles).where(eq(providerLocalProfiles.name, name)).get();
    if (duplicate) {
      throw new Error("Local OpenAI profile name already exists.");
    }

    const hasAnyProfile = Boolean(tx.select().from(providerLocalProfiles).limit(1).get());
    tx.insert(providerLocalProfiles)
      .values({
        id: profileId,
        name,
        apiKey,
        baseUrl: trimToNull(input.baseUrl),
        model: trimToNull(input.model),
        timeoutMs: optionalPositiveInteger(input.timeoutMs, "Local OpenAI timeout"),
        createdAt: now,
        updatedAt: now
      })
      .run();

    if (!hasAnyProfile) {
      const configRow = tx.select().from(providerConfigs).where(eq(providerConfigs.id, ACTIVE_PROVIDER_CONFIG_ID)).get();
      tx.insert(providerConfigs)
        .values({
          id: ACTIVE_PROVIDER_CONFIG_ID,
          sourceOrderJson: configRow?.sourceOrderJson ?? JSON.stringify(DEFAULT_PROVIDER_SOURCE_ORDER),
          localApiKey: null,
          localBaseUrl: null,
          localModel: null,
          localTimeoutMs: null,
          activeProfileId: profileId,
          createdAt: configRow?.createdAt ?? now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: providerConfigs.id,
          set: {
            activeProfileId: profileId,
            updatedAt: now
          }
        })
        .run();
    }

    created = tx.select().from(providerLocalProfiles).where(eq(providerLocalProfiles.id, profileId)).get();
  });

  if (!created) {
    throw new Error("Local OpenAI profile was not created.");
  }
  return localProfileView(created);
}

export function updateLocalProfile(id: string, input: UpdateLocalProfileInput): LocalOpenAIProfile {
  const profileId = requiredProfileId(id);
  const now = new Date().toISOString();
  let updated: ProviderLocalProfileRow | undefined;

  db.transaction((tx) => {
    const existing = tx.select().from(providerLocalProfiles).where(eq(providerLocalProfiles.id, profileId)).get();
    if (!existing) {
      throw new Error("Local OpenAI profile not found.");
    }

    const name = Object.hasOwn(input, "name") ? requiredProfileName(input.name) : existing.name;
    const duplicate = tx.select().from(providerLocalProfiles).where(eq(providerLocalProfiles.name, name)).get();
    if (duplicate && duplicate.id !== profileId) {
      throw new Error("Local OpenAI profile name already exists.");
    }

    tx.update(providerLocalProfiles)
      .set({
        name,
        apiKey: resolveUpdatedApiKey(input, existing),
        baseUrl: Object.hasOwn(input, "baseUrl") ? trimToNull(input.baseUrl) : existing.baseUrl,
        model: Object.hasOwn(input, "model") ? trimToNull(input.model) : existing.model,
        timeoutMs: Object.hasOwn(input, "timeoutMs")
          ? optionalPositiveInteger(input.timeoutMs, "Local OpenAI timeout")
          : existing.timeoutMs,
        updatedAt: now
      })
      .where(eq(providerLocalProfiles.id, profileId))
      .run();

    updated = tx.select().from(providerLocalProfiles).where(eq(providerLocalProfiles.id, profileId)).get();
  });

  if (!updated) {
    throw new Error("Local OpenAI profile was not updated.");
  }
  return localProfileView(updated);
}

export function deleteLocalProfile(id: string): ProviderConfigResponse {
  const profileId = requiredProfileId(id);
  const now = new Date().toISOString();

  db.transaction((tx) => {
    const existing = tx.select().from(providerLocalProfiles).where(eq(providerLocalProfiles.id, profileId)).get();
    if (!existing) {
      throw new Error("Local OpenAI profile not found.");
    }

    tx.delete(providerLocalProfiles).where(eq(providerLocalProfiles.id, profileId)).run();

    const configRow = tx.select().from(providerConfigs).where(eq(providerConfigs.id, ACTIVE_PROVIDER_CONFIG_ID)).get();
    if (configRow?.activeProfileId === profileId) {
      tx.update(providerConfigs)
        .set({ activeProfileId: null, updatedAt: now })
        .where(eq(providerConfigs.id, ACTIVE_PROVIDER_CONFIG_ID))
        .run();
    }
  });

  return getProviderConfig();
}

export function setActiveLocalProfile(id: string | null): ProviderConfigResponse {
  const profileId = optionalProfileId(id);
  const now = new Date().toISOString();

  db.transaction((tx) => {
    if (profileId && !tx.select().from(providerLocalProfiles).where(eq(providerLocalProfiles.id, profileId)).get()) {
      throw new Error("Local OpenAI profile not found.");
    }

    const configRow = tx.select().from(providerConfigs).where(eq(providerConfigs.id, ACTIVE_PROVIDER_CONFIG_ID)).get();
    tx.insert(providerConfigs)
      .values({
        id: ACTIVE_PROVIDER_CONFIG_ID,
        sourceOrderJson: configRow?.sourceOrderJson ?? JSON.stringify(DEFAULT_PROVIDER_SOURCE_ORDER),
        localApiKey: configRow?.localApiKey ?? null,
        localBaseUrl: configRow?.localBaseUrl ?? null,
        localModel: configRow?.localModel ?? null,
        localTimeoutMs: configRow?.localTimeoutMs ?? null,
        activeProfileId: profileId,
        createdAt: configRow?.createdAt ?? now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: providerConfigs.id,
        set: {
          activeProfileId: profileId,
          updatedAt: now
        }
      })
      .run();
  });

  return getProviderConfig();
}

export function getLocalProfileById(id: string): LocalOpenAIProfileRecord | undefined {
  const profile = getLocalProfileRow(id);
  return profile ? localProfileRecord(profile) : undefined;
}

export function isProviderSourceOrder(value: unknown): value is ProviderSourceId[] {
  return parseProviderSourceOrder(value) !== undefined;
}

export function isProviderSourceId(value: unknown): value is ProviderSourceId {
  return typeof value === "string" && (PROVIDER_SOURCE_IDS as readonly string[]).includes(value);
}

function getProviderConfigRow(): ProviderConfigRow | undefined {
  return db.select().from(providerConfigs).where(eq(providerConfigs.id, ACTIVE_PROVIDER_CONFIG_ID)).get();
}

function getActiveLocalProfile(row = getProviderConfigRow()): ProviderLocalProfileRow | undefined {
  return row?.activeProfileId ? getLocalProfileRow(row.activeProfileId) : undefined;
}

function getLocalProfileRow(id: string): ProviderLocalProfileRow | undefined {
  const profileId = trimToUndefined(id);
  return profileId ? db.select().from(providerLocalProfiles).where(eq(providerLocalProfiles.id, profileId)).get() : undefined;
}

function providerSources(activeProfile: ProviderLocalProfileRow | undefined): ProviderSourceView[] {
  const envConfig = getEnvironmentOpenAIImageProviderConfig();
  const localConfig = localProfileToOpenAIConfig(activeProfile);
  const codex = codexSessionView(getCodexTokenRow());

  return [
    {
      id: "env-openai",
      kind: "environment",
      label: "Environment OpenAI API",
      available: Boolean(envConfig),
      status: envConfig ? "available" : "missing_api_key",
      details: {
        baseUrl: process.env.OPENAI_BASE_URL?.trim() || "",
        model: getConfiguredImageModel(),
        timeoutMs: parseOpenAIImageTimeoutMs(process.env.OPENAI_IMAGE_TIMEOUT_MS)
      },
      secret: maskedSecret(process.env.OPENAI_API_KEY)
    },
    {
      id: "local-openai",
      kind: "local",
      label: "Local OpenAI-compatible API",
      available: Boolean(localConfig),
      status: localConfig ? "available" : "missing_api_key",
      details: {
        baseUrl: activeProfile?.baseUrl ?? "",
        model: trimToUndefined(activeProfile?.model) ?? IMAGE_MODEL,
        timeoutMs: validTimeoutMs(activeProfile?.timeoutMs) ?? DEFAULT_OPENAI_IMAGE_TIMEOUT_MS
      },
      secret: maskedSecret(activeProfile?.apiKey)
    },
    {
      id: "codex",
      kind: "codex",
      label: "Codex",
      available: codex.available,
      status: codex.available ? "available" : "missing_codex_session",
      details: {
        codex
      },
      secret: {
        hasSecret: false
      }
    }
  ];
}

function localOpenAIConfigView(profile: ProviderLocalProfileRow | undefined): LocalOpenAIProviderConfigView {
  return {
    apiKey: maskedSecret(profile?.apiKey),
    baseUrl: profile?.baseUrl ?? "",
    model: trimToUndefined(profile?.model) ?? IMAGE_MODEL,
    timeoutMs: validTimeoutMs(profile?.timeoutMs) ?? DEFAULT_OPENAI_IMAGE_TIMEOUT_MS
  };
}

function localProfileView(profile: ProviderLocalProfileRow): LocalOpenAIProfile {
  return {
    id: profile.id,
    name: profile.name,
    apiKey: maskedSecret(profile.apiKey),
    baseUrl: profile.baseUrl ?? "",
    model: trimToUndefined(profile.model) ?? IMAGE_MODEL,
    timeoutMs: validTimeoutMs(profile.timeoutMs) ?? DEFAULT_OPENAI_IMAGE_TIMEOUT_MS,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function localProfileRecord(profile: ProviderLocalProfileRow): LocalOpenAIProfileRecord {
  return {
    id: profile.id,
    name: profile.name,
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
    timeoutMs: profile.timeoutMs,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function localProfileToOpenAIConfig(profile: ProviderLocalProfileRow | undefined): OpenAIImageProviderConfig | undefined {
  if (!profile?.apiKey.trim()) {
    return undefined;
  }

  return {
    apiKey: profile.apiKey.trim(),
    baseURL: trimToUndefined(profile.baseUrl),
    model: trimToUndefined(profile.model) ?? IMAGE_MODEL,
    timeoutMs: validTimeoutMs(profile.timeoutMs) ?? DEFAULT_OPENAI_IMAGE_TIMEOUT_MS
  };
}

function providerSourceSummary(source: ProviderSourceView): ProviderSourceSummary {
  return {
    id: source.id,
    kind: source.kind,
    label: source.label,
    provider: runtimeProviderForSource(source.id),
    available: source.available,
    status: source.status
  };
}

function runtimeProviderForSource(sourceId: ProviderSourceId): RuntimeImageProvider {
  if (sourceId === "codex") {
    return "codex";
  }

  return "openai";
}

function resolveActiveProfileIdForSave(
  input: SaveProviderConfigRequest["localOpenAI"],
  existingActiveProfileId: string | null
): string | null {
  if (input === undefined) {
    return existingActiveProfileId;
  }
  if (input === null || typeof input === "string") {
    return optionalProfileId(input);
  }
  if (Object.hasOwn(input, "activeProfileId")) {
    const value = input.activeProfileId;
    if (value !== null && value !== undefined && typeof value !== "string") {
      throw new Error("Local OpenAI active profile id must be a string or null.");
    }
    return optionalProfileId(value ?? null);
  }

  return existingActiveProfileId;
}

function requiredProfileName(value: string | undefined): string {
  const name = trimToUndefined(value);
  if (!name) {
    throw new Error("Local OpenAI profile name is required.");
  }
  return name;
}

function requiredApiKey(value: string | undefined): string {
  const apiKey = trimToUndefined(value);
  if (!apiKey) {
    throw new Error("Local OpenAI API key is required.");
  }
  return apiKey;
}

function resolveUpdatedApiKey(input: UpdateLocalProfileInput, existing: ProviderLocalProfileRow): string {
  if (!Object.hasOwn(input, "apiKey")) {
    return existing.apiKey;
  }

  const apiKey = trimToUndefined(input.apiKey);
  if (apiKey) {
    return apiKey;
  }
  if (input.preserveApiKey === true) {
    return existing.apiKey;
  }

  throw new Error("Local OpenAI API key is required.");
}

function requiredProfileId(value: string): string {
  const profileId = trimToUndefined(value);
  if (!profileId) {
    throw new Error("Local OpenAI profile id is required.");
  }
  return profileId;
}

function optionalProfileId(value: string | null | undefined): string | null {
  return trimToUndefined(value) ?? null;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | null {
  if (value === undefined) {
    return null;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function readSavedSourceOrder(value: string | undefined): ProviderSourceId[] {
  if (!value) {
    return [...DEFAULT_PROVIDER_SOURCE_ORDER];
  }

  try {
    return parseProviderSourceOrder(JSON.parse(value) as unknown) ?? [...DEFAULT_PROVIDER_SOURCE_ORDER];
  } catch {
    return [...DEFAULT_PROVIDER_SOURCE_ORDER];
  }
}

function parseProviderSourceOrder(value: unknown): ProviderSourceId[] | undefined {
  if (!Array.isArray(value) || value.length !== PROVIDER_SOURCE_IDS.length) {
    return undefined;
  }

  if (!value.every(isProviderSourceId)) {
    return undefined;
  }

  const unique = new Set(value);
  if (unique.size !== PROVIDER_SOURCE_IDS.length) {
    return undefined;
  }

  return PROVIDER_SOURCE_IDS.every((sourceId) => unique.has(sourceId)) ? [...value] : undefined;
}

function getCodexTokenRow(): CodexTokenRow | undefined {
  return db.select().from(codexOAuthTokens).where(eq(codexOAuthTokens.id, CODEX_TOKEN_ROW_ID)).get();
}

function codexSessionView(row: CodexTokenRow | undefined): CodexAuthSessionView {
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
  return Boolean(row?.accessToken?.trim() && row.refreshToken?.trim() && !row.unavailableAt);
}

function maskedSecret(value: string | null | undefined): MaskedSecret {
  const trimmed = trimToUndefined(value);
  return {
    hasSecret: Boolean(trimmed),
    value: trimmed ? maskSecret(trimmed) : undefined
  };
}

function maskSecret(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 4)}${"*".repeat(Math.min(8, Math.max(4, value.length - 8)))}${value.slice(-4)}`;
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function trimToNull(value: string | undefined): string | null {
  return value?.trim() || null;
}

function validTimeoutMs(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
