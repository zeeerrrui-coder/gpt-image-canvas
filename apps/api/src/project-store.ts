import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type {
  GeneratedAsset,
  GalleryImageItem,
  GalleryResponse,
  GenerationRecord as ApiGenerationRecord,
  GenerationStatus,
  ImageMode,
  ImageQuality,
  OutputFormat,
  OutputStatus,
  ProjectState
} from "./contracts.js";
import { db } from "./database.js";
import { assets, generationOutputs, generationRecords, generationReferenceAssets, projects } from "./schema.js";

export const DEFAULT_PROJECT_ID = "default";
const DEFAULT_PROJECT_NAME = "Default Project";
const fallbackWarnings = new Set<string>();

interface ProjectSnapshotInput {
  name?: string;
  snapshotJson: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseSnapshot(snapshotJson: string): unknown | null {
  return JSON.parse(snapshotJson) as unknown;
}

export function ensureDefaultProject(userId: string): void {
  const existing = getDefaultProjectRow(userId);

  if (existing) {
    return;
  }
  if (defaultProjectRowExists(userId)) {
    return;
  }

  const createdAt = nowIso();
  db.insert(projects)
    .values({
      id: projectIdForUser(userId),
      userId,
      name: DEFAULT_PROJECT_NAME,
      snapshotJson: "null",
      createdAt,
      updatedAt: createdAt
    })
    .run();
}

export function saveProjectSnapshot(input: ProjectSnapshotInput, userId: string): ProjectState {
  ensureDefaultProject(userId);

  const updatedAt = nowIso();
  const current = getDefaultProjectRow(userId);

  db.update(projects)
    .set({
      name: input.name ?? current?.name ?? DEFAULT_PROJECT_NAME,
      snapshotJson: input.snapshotJson,
      updatedAt
    })
    .where(eq(projects.id, projectIdForUser(userId)))
    .run();

  return getProjectState(userId);
}

export function getProjectState(userId: string): ProjectState {
  ensureDefaultProject(userId);

  const project = getDefaultProjectRow(userId);

  if (!project) {
    return {
      id: projectIdForUser(userId),
      name: DEFAULT_PROJECT_NAME,
      snapshot: null,
      history: getGenerationHistory(userId),
      updatedAt: nowIso()
    };
  }

  return {
    id: project.id,
    name: project.name,
    snapshot: parseSnapshot(project.snapshotJson),
    history: getGenerationHistory(userId),
    updatedAt: project.updatedAt
  };
}

export function getGalleryImages(userId: string): GalleryResponse {
  const rows = db
    .select({
      output: generationOutputs,
      generation: generationRecords,
      asset: assets
    })
    .from(generationOutputs)
    .innerJoin(generationRecords, eq(generationOutputs.generationId, generationRecords.id))
    .innerJoin(assets, eq(generationOutputs.assetId, assets.id))
    .where(and(eq(generationOutputs.status, "succeeded"), eq(generationRecords.userId, userId)))
    .orderBy(desc(generationOutputs.createdAt))
    .all();

  return {
    items: rows.map(({ output, generation, asset }) => ({
      outputId: output.id,
      generationId: generation.id,
      mode: generation.mode as ImageMode,
      prompt: generation.prompt,
      effectivePrompt: generation.effectivePrompt,
      presetId: generation.presetId,
      size: {
        width: generation.width,
        height: generation.height
      },
      quality: generation.quality as ImageQuality,
      outputFormat: generation.outputFormat as OutputFormat,
      createdAt: output.createdAt,
      asset: toGeneratedAsset(asset)
    })).filter((item): item is GalleryImageItem => Boolean(item.asset))
  };
}

export function getGenerationRecordById(generationId: string, userId: string): ApiGenerationRecord | null {
  try {
    const record = db.select().from(generationRecords).where(eq(generationRecords.id, generationId)).get();
    if (!record || record.userId !== userId) {
      return null;
    }

    const outputs = db.select().from(generationOutputs).where(eq(generationOutputs.generationId, generationId)).orderBy(generationOutputs.createdAt).all();
    const referenceRows = db
      .select()
      .from(generationReferenceAssets)
      .where(eq(generationReferenceAssets.generationId, generationId))
      .all()
      .sort((a, b) => a.position - b.position);
    const assetIds = outputs.flatMap((output) => (output.assetId ? [output.assetId] : []));
    const assetRows = assetIds.length > 0 ? db.select().from(assets).where(inArray(assets.id, assetIds)).all() : [];
    const assetById = new Map(assetRows.map((asset) => [asset.id, asset]));

    const mappedOutputs = outputs.map((output) => ({
      id: output.id,
      status: output.status as OutputStatus,
      asset: output.assetId ? toGeneratedAsset(assetById.get(output.assetId)) : undefined,
      error: output.error ?? undefined
    }));

    const referenceAssetIds = referenceRows.map((row) => row.assetId);

    return {
      id: record.id,
      mode: record.mode as ImageMode,
      prompt: record.prompt,
      effectivePrompt: record.effectivePrompt,
      presetId: record.presetId,
      size: { width: record.width, height: record.height },
      quality: record.quality as ImageQuality,
      outputFormat: record.outputFormat as OutputFormat,
      count: record.count,
      status: record.status as GenerationStatus,
      error: record.error ?? undefined,
      referenceAssetIds: referenceAssetIds.length > 0 ? referenceAssetIds : undefined,
      referenceAssetId: record.referenceAssetId ?? undefined,
      createdAt: record.createdAt,
      outputs: mappedOutputs
    };
  } catch {
    return null;
  }
}

export interface DeletedAssetCloudInfo {
  bucket: string;
  region: string;
  objectKey: string;
}

export function deleteGenerationRecord(generationId: string, userId: string): {
  ok: boolean;
  assetFilePaths: string[];
  cloudObjects: DeletedAssetCloudInfo[];
} {
  const record = db.select().from(generationRecords).where(eq(generationRecords.id, generationId)).get();
  if (!record || record.userId !== userId) {
    return { ok: false, assetFilePaths: [], cloudObjects: [] };
  }

  const outputs = db.select().from(generationOutputs).where(eq(generationOutputs.generationId, generationId)).all();
  const candidateAssetIds = [
    ...new Set(outputs.flatMap((output) => (output.assetId ? [output.assetId] : [])))
  ];

  let assetFilePaths: string[] = [];
  let cloudObjects: DeletedAssetCloudInfo[] = [];

  db.transaction((tx) => {
    // Cascade 在升级 DB 上不一定生效（ALTER TABLE FK 限制），显式删 outputs/refs。
    tx.delete(generationOutputs).where(eq(generationOutputs.generationId, generationId)).run();
    tx.delete(generationReferenceAssets).where(eq(generationReferenceAssets.generationId, generationId)).run();
    tx.delete(generationRecords).where(eq(generationRecords.id, generationId)).run();

    if (candidateAssetIds.length === 0) {
      return;
    }

    // 过滤掉仍被其他 generation_records / generation_reference_assets 引用的 asset
    // （比如用户把生成结果作为参考图复用进了下一次生成）
    const stillReferenced = new Set<string>();
    for (const row of tx
      .select({ assetId: generationRecords.referenceAssetId })
      .from(generationRecords)
      .where(and(inArray(generationRecords.referenceAssetId, candidateAssetIds), ne(generationRecords.id, generationId)))
      .all()) {
      if (row.assetId) {
        stillReferenced.add(row.assetId);
      }
    }
    for (const row of tx
      .select({ assetId: generationReferenceAssets.assetId })
      .from(generationReferenceAssets)
      .where(and(inArray(generationReferenceAssets.assetId, candidateAssetIds), ne(generationReferenceAssets.generationId, generationId)))
      .all()) {
      stillReferenced.add(row.assetId);
    }
    for (const row of tx
      .select({ assetId: generationOutputs.assetId })
      .from(generationOutputs)
      .where(inArray(generationOutputs.assetId, candidateAssetIds))
      .all()) {
      if (row.assetId) {
        stillReferenced.add(row.assetId);
      }
    }

    const deletableAssetIds = candidateAssetIds.filter((id) => !stillReferenced.has(id));
    if (deletableAssetIds.length === 0) {
      return;
    }

    const assetRows = tx.select().from(assets).where(inArray(assets.id, deletableAssetIds)).all();
    assetFilePaths = assetRows.map((asset) => asset.relativePath);
    cloudObjects = assetRows
      .filter((asset) => asset.cloudProvider === "cos" && asset.cloudStatus === "uploaded" && asset.cloudBucket && asset.cloudRegion && asset.cloudObjectKey)
      .map((asset) => ({
        bucket: asset.cloudBucket as string,
        region: asset.cloudRegion as string,
        objectKey: asset.cloudObjectKey as string
      }));

    tx.delete(assets).where(inArray(assets.id, deletableAssetIds)).run();
  });

  return { ok: true, assetFilePaths, cloudObjects };
}

export function deleteGalleryOutput(outputId: string, userId: string): boolean {
  const ownedOutput = db
    .select({ id: generationOutputs.id })
    .from(generationOutputs)
    .innerJoin(generationRecords, eq(generationOutputs.generationId, generationRecords.id))
    .where(and(eq(generationOutputs.id, outputId), eq(generationRecords.userId, userId)))
    .get();
  if (!ownedOutput) {
    return false;
  }

  const result = db.delete(generationOutputs).where(eq(generationOutputs.id, outputId)).run();
  return result.changes > 0;
}

function projectIdForUser(userId: string): string {
  return `${DEFAULT_PROJECT_ID}:${userId}`;
}

function getDefaultProjectRow(userId: string): (typeof projects.$inferSelect) | undefined {
  try {
    return db.select().from(projects).where(eq(projects.id, projectIdForUser(userId))).get();
  } catch (error) {
    warnOnce(
      "project-read-fallback",
      `Project row could not be read; returning a blank canvas fallback. ${formatErrorSummary(error)}`
    );
    return undefined;
  }
}

function defaultProjectRowExists(userId: string): boolean {
  try {
    const row = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectIdForUser(userId))).get();
    return Boolean(row);
  } catch {
    return true;
  }
}

function getGenerationHistory(userId: string): ApiGenerationRecord[] {
  try {
    return readGenerationHistory(userId);
  } catch (error) {
    warnOnce(
      "history-read-fallback",
      `Generation history could not be read; returning an empty history. ${formatErrorSummary(error)}`
    );
    return [];
  }
}

function warnOnce(key: string, message: string): void {
  if (fallbackWarnings.has(key)) {
    return;
  }

  fallbackWarnings.add(key);
  console.warn(message);
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const codeValue = (error as { code?: unknown }).code;
    const code = typeof codeValue === "string" ? `${codeValue}: ` : "";
    return `${code}${error.message}`;
  }

  return String(error);
}

function readGenerationHistory(userId: string): ApiGenerationRecord[] {
  const records = db
    .select()
    .from(generationRecords)
    .where(eq(generationRecords.userId, userId))
    .orderBy(desc(generationRecords.createdAt))
    .limit(20)
    .all();
  if (records.length === 0) {
    return [];
  }

  const generationIds = records.map((record) => record.id);
  const outputs = db
    .select()
    .from(generationOutputs)
    .where(inArray(generationOutputs.generationId, generationIds))
    .orderBy(generationOutputs.createdAt)
    .all();
  const referenceRows = db
    .select()
    .from(generationReferenceAssets)
    .where(inArray(generationReferenceAssets.generationId, generationIds))
    .all()
    .sort((left, right) =>
      left.generationId === right.generationId
        ? left.position - right.position
        : left.generationId.localeCompare(right.generationId)
    );

  const assetIds = outputs.flatMap((output) => (output.assetId ? [output.assetId] : []));
  const assetRows =
    assetIds.length > 0 ? db.select().from(assets).where(inArray(assets.id, assetIds)).all() : [];
  const assetById = new Map(assetRows.map((asset) => [asset.id, asset]));

  const outputsByGenerationId = new Map<string, typeof outputs>();
  for (const output of outputs) {
    const existing = outputsByGenerationId.get(output.generationId) ?? [];
    existing.push(output);
    outputsByGenerationId.set(output.generationId, existing);
  }
  const referenceAssetIdsByGenerationId = new Map<string, string[]>();
  for (const referenceRow of referenceRows) {
    const existing = referenceAssetIdsByGenerationId.get(referenceRow.generationId) ?? [];
    existing.push(referenceRow.assetId);
    referenceAssetIdsByGenerationId.set(referenceRow.generationId, existing);
  }

  return records.flatMap((record) => {
    const mappedOutputs = (outputsByGenerationId.get(record.id) ?? []).map((output) => ({
      id: output.id,
      status: output.status as OutputStatus,
      asset: output.assetId ? toGeneratedAsset(assetById.get(output.assetId)) : undefined,
      error: output.error ?? undefined
    }));

    if (mappedOutputs.length === 0) {
      return [];
    }

    return [
      {
        id: record.id,
        mode: record.mode as ImageMode,
        prompt: record.prompt,
        effectivePrompt: record.effectivePrompt,
        presetId: record.presetId,
        size: {
          width: record.width,
          height: record.height
        },
        quality: record.quality as ImageQuality,
        outputFormat: record.outputFormat as OutputFormat,
        count: record.count,
        status: record.status as GenerationStatus,
        error: record.error ?? undefined,
        referenceAssetIds: referenceAssetIdsByGenerationId.get(record.id) ?? (record.referenceAssetId ? [record.referenceAssetId] : undefined),
        referenceAssetId: record.referenceAssetId ?? undefined,
        createdAt: record.createdAt,
        outputs: mappedOutputs
      }
    ];
  });
}

function toGeneratedAsset(asset: (typeof assets.$inferSelect) | undefined): GeneratedAsset | undefined {
  if (!asset) {
    return undefined;
  }

  return {
    id: asset.id,
    url: `/api/assets/${asset.id}`,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    cloud:
      asset.cloudProvider === "cos" && (asset.cloudStatus === "uploaded" || asset.cloudStatus === "failed")
        ? {
            provider: asset.cloudProvider,
            status: asset.cloudStatus,
            lastError: asset.cloudError ?? undefined,
            uploadedAt: asset.cloudUploadedAt ?? undefined
          }
        : undefined
  };
}
