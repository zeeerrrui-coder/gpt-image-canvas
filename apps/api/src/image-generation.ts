import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type {
  AssetMetadataResponse,
  GeneratedAsset,
  GeneratedAssetCloudInfo,
  GenerationOutput,
  GenerationRecord,
  GenerationResponse,
  GenerationStatus,
  ImageSize,
  OutputFormat,
  ReferenceImageInput
} from "./contracts.js";
import { db } from "./database.js";
import {
  ProviderError,
  type EditImageProviderInput,
  type ImageProvider,
  type ImageProviderInput,
  type ProviderImage
} from "./image-provider.js";
import {
  CosAssetStorageAdapter,
  LocalAssetStorageAdapter,
  buildCosObjectKey,
  storageErrorMessage,
  type CosAssetLocation
} from "./asset-storage.js";
import { runtimePaths } from "./runtime.js";
import { assets, generationOutputs, generationRecords, generationReferenceAssets } from "./schema.js";
import { getActiveCosStorageConfig } from "./storage-config.js";

const BATCH_CONCURRENCY = 2;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const SUPPORTED_REFERENCE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const localAssetStorage = new LocalAssetStorageAdapter();

interface StoredAssetFile {
  id: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  cloud?: CosAssetLocation;
}

interface BatchOutputResult {
  id: string;
  status: "succeeded" | "failed";
  asset?: GeneratedAsset;
  cloudStorage?: AssetCloudStorageRecord;
  error?: string;
}

interface SavedProviderImage {
  asset: GeneratedAsset;
  cloudStorage?: AssetCloudStorageRecord;
}

interface AssetCloudStorageRecord {
  provider: "cos";
  bucket: string;
  region: string;
  objectKey: string;
  status: "uploaded" | "failed";
  error?: string;
  uploadedAt?: string;
  etag?: string;
  requestId?: string;
}

type PersistedGenerationInput = ImageProviderInput & {
  mode: "generate" | "edit";
  userId: string;
  referenceAssetIds?: string[];
  referenceAssetId?: string;
};

const mimeTypes: Record<OutputFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};

export async function runTextToImageGeneration(
  input: ImageProviderInput,
  provider: ImageProvider,
  userId: string,
  signal?: AbortSignal
): Promise<GenerationResponse> {
  const outputs = await mapWithConcurrency(
    Array.from({ length: input.count }, (_, index) => index),
    BATCH_CONCURRENCY,
    async () => generateSingleOutput(input, provider, userId, signal)
  );

  const record = saveGenerationRecord(
    {
      ...input,
      mode: "generate",
      userId
    },
    outputs
  );

  return {
    record
  };
}

export async function runReferenceImageGeneration(
  input: EditImageProviderInput,
  provider: ImageProvider,
  userId: string,
  signal?: AbortSignal
): Promise<GenerationResponse> {
  const referenceAssetIds = await ensureReferenceAssetIds(input, userId);
  const inputWithReferenceAssets: EditImageProviderInput = {
    ...input,
    referenceAssetIds,
    referenceAssetId: referenceAssetIds[0]
  };

  const outputs = await mapWithConcurrency(
    Array.from({ length: inputWithReferenceAssets.count }, (_, index) => index),
    BATCH_CONCURRENCY,
    async () => editSingleOutput(inputWithReferenceAssets, provider, userId, signal)
  );

  const record = saveGenerationRecord(
    {
      ...inputWithReferenceAssets,
      mode: "edit",
      userId
    },
    outputs
  );

  return {
    record
  };
}

async function ensureReferenceAssetIds(input: EditImageProviderInput, userId: string): Promise<string[]> {
  if (input.referenceAssetIds?.length === input.referenceImages.length) {
    return input.referenceAssetIds;
  }

  const savedReferenceAssets = await Promise.all(input.referenceImages.map((referenceImage) => saveReferenceImageInput(referenceImage, userId)));
  return savedReferenceAssets.map((asset) => asset.id);
}

async function saveReferenceImageInput(input: ReferenceImageInput, userId: string): Promise<GeneratedAsset> {
  const parsed = referenceDataUrlToBytes(input);
  const imageSize = await readImageSize(parsed.bytes);
  if (!imageSize) {
    throw new ProviderError("unsupported_provider_behavior", "Reference image dimensions could not be read.", 400);
  }

  const assetId = randomUUID();
  const extension = extensionForMimeType(parsed.mimeType);
  const fileName = `${assetId}.${extension}`;
  const relativePath = `assets/${fileName}`;
  const filePath = resolve(runtimePaths.dataDir, relativePath);
  const createdAt = new Date().toISOString();

  await localAssetStorage.putObject({ filePath, bytes: parsed.bytes });
  db.insert(assets)
    .values({
      id: assetId,
      userId,
      fileName,
      relativePath,
      mimeType: parsed.mimeType,
      width: imageSize.width,
      height: imageSize.height,
      createdAt
    })
    .run();

  return {
    id: assetId,
    url: `/api/assets/${assetId}`,
    fileName,
    mimeType: parsed.mimeType,
    width: imageSize.width,
    height: imageSize.height
  };
}

function referenceDataUrlToBytes(input: ReferenceImageInput): { bytes: Buffer; mimeType: string } {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(input.dataUrl);
  if (!match) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像格式不受支持。", 400);
  }

  const mimeType = match[1].toLowerCase();
  if (!SUPPORTED_REFERENCE_MIME_TYPES.has(mimeType)) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像必须是 PNG、JPEG 或 WebP 格式。", 400);
  }

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像不能超过 50MB。", 400);
  }

  return {
    bytes,
    mimeType: mimeType === "image/jpg" ? "image/jpeg" : mimeType
  };
}

function extensionForMimeType(mimeType: string): string {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1] || "png";
}

export function getStoredAssetFile(assetId: string, userId?: string): StoredAssetFile | undefined {
  const asset = db.select().from(assets).where(eq(assets.id, assetId)).get();
  if (!asset) {
    return undefined;
  }
  if (userId && asset.userId !== userId) {
    return undefined;
  }

  const filePath = resolve(runtimePaths.dataDir, asset.relativePath);
  if (!isInsideDirectory(filePath, runtimePaths.assetsDir)) {
    return undefined;
  }

  return {
    id: asset.id,
    fileName: asset.fileName,
    filePath,
    mimeType: asset.mimeType,
    cloud: toCosAssetLocation(asset)
  };
}

export async function readStoredAsset(assetId: string, userId?: string): Promise<{ file: StoredAssetFile; bytes: Buffer } | undefined> {
  const file = getStoredAssetFile(assetId, userId);
  if (!file) {
    return undefined;
  }

  try {
    return {
      file,
      bytes: await localAssetStorage.getObject({ filePath: file.filePath })
    };
  } catch {
    const bytes = await readCloudAsset(file.cloud);
    if (!bytes) {
      return undefined;
    }

    void localAssetStorage.putObject({ filePath: file.filePath, bytes }).catch(() => undefined);
    return {
      file,
      bytes
    };
  }
}

export async function readStoredAssetMetadata(assetId: string, userId?: string): Promise<AssetMetadataResponse | undefined> {
  const asset = await readStoredAsset(assetId, userId);
  if (!asset) {
    return undefined;
  }

  const size = await readImageSize(asset.bytes);
  if (!size) {
    return undefined;
  }

  return {
    id: asset.file.id,
    width: size.width,
    height: size.height
  };
}

async function generateSingleOutput(
  input: ImageProviderInput,
  provider: ImageProvider,
  userId: string,
  signal?: AbortSignal
): Promise<BatchOutputResult> {
  const outputId = randomUUID();

  try {
    throwIfAborted(signal);
    const result = await provider.generate(
      {
        ...input,
        count: 1
      },
      signal
    );
    throwIfAborted(signal);

    const providerImage = result.images[0];
    if (!providerImage) {
      throw new ProviderError("unsupported_provider_behavior", "上游图像服务没有返回图像结果。", 502);
    }

    const saved = await saveProviderImage(providerImage, input, userId, signal);

    return {
      id: outputId,
      status: "succeeded",
      asset: saved.asset,
      cloudStorage: saved.cloudStorage
    };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw error;
    }

    return {
      id: outputId,
      status: "failed",
      error: errorToMessage(error)
    };
  }
}

async function editSingleOutput(
  input: EditImageProviderInput,
  provider: ImageProvider,
  userId: string,
  signal?: AbortSignal
): Promise<BatchOutputResult> {
  const outputId = randomUUID();

  try {
    throwIfAborted(signal);
    const result = await provider.edit(
      {
        ...input,
        count: 1
      },
      signal
    );
    throwIfAborted(signal);

    const providerImage = result.images[0];
    if (!providerImage) {
      throw new ProviderError("unsupported_provider_behavior", "上游图像服务没有返回图像结果。", 502);
    }

    const saved = await saveProviderImage(providerImage, input, userId, signal);

    return {
      id: outputId,
      status: "succeeded",
      asset: saved.asset,
      cloudStorage: saved.cloudStorage
    };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw error;
    }

    return {
      id: outputId,
      status: "failed",
      error: errorToMessage(error)
    };
  }
}

async function saveProviderImage(
  image: ProviderImage,
  input: ImageProviderInput,
  userId: string,
  _signal?: AbortSignal
): Promise<SavedProviderImage> {
  const assetId = randomUUID();
  const fileName = `${assetId}.${input.outputFormat === "jpeg" ? "jpg" : input.outputFormat}`;
  const relativePath = `assets/${fileName}`;
  const filePath = resolve(runtimePaths.dataDir, relativePath);
  const mimeType = mimeTypes[input.outputFormat];
  const bytes = Buffer.from(image.b64Json, "base64");
  const imageSize = await readImageSize(bytes);

  if (!imageSize) {
    throw new ProviderError("unsupported_provider_behavior", "Generated image dimensions could not be read.", 502);
  }

  await localAssetStorage.putObject({ filePath, bytes });
  const cloudStorage = await saveAssetToConfiguredCloud({
    fileName,
    bytes,
    mimeType,
    createdAt: new Date().toISOString()
  });

  return {
    asset: {
      id: assetId,
      url: `/api/assets/${assetId}`,
      fileName,
      mimeType,
      width: imageSize.width,
      height: imageSize.height,
      cloud: toGeneratedAssetCloud(cloudStorage)
    },
    cloudStorage
  };
}

async function readImageSize(bytes: Buffer): Promise<ImageSize | undefined> {
  try {
    const metadata = await sharp(bytes).metadata();
    if (!metadata.width || !metadata.height) {
      return undefined;
    }

    return {
      width: metadata.width,
      height: metadata.height
    };
  } catch {
    return undefined;
  }
}

function saveGenerationRecord(input: PersistedGenerationInput, outputs: BatchOutputResult[]): GenerationRecord {
  const createdAt = new Date().toISOString();
  const generationId = randomUUID();
  const successCount = outputs.filter((output) => output.status === "succeeded").length;
  const failureCount = outputs.length - successCount;
  const status = resolveGenerationStatus(successCount, failureCount);
  const error = failureCount > 0 ? `${failureCount} 张图像生成失败。` : undefined;

  const referenceAssetIds = input.referenceAssetIds ?? (input.referenceAssetId ? [input.referenceAssetId] : []);
  const primaryReferenceAssetId = referenceAssetIds[0] ?? input.referenceAssetId;

  db.insert(generationRecords)
    .values({
      id: generationId,
      userId: input.userId,
      mode: input.mode,
      prompt: input.originalPrompt,
      effectivePrompt: input.prompt,
      presetId: input.presetId,
      width: input.size.width,
      height: input.size.height,
      quality: input.quality,
      outputFormat: input.outputFormat,
      count: input.count,
      status,
      error,
      referenceAssetId: primaryReferenceAssetId ?? null,
      createdAt
    })
    .run();

  referenceAssetIds.forEach((assetId, position) => {
    db.insert(generationReferenceAssets)
      .values({
        generationId,
        assetId,
        position,
        createdAt
      })
      .run();
  });

  for (const output of outputs) {
    if (output.asset) {
      db.insert(assets)
        .values({
          id: output.asset.id,
          userId: input.userId,
          fileName: output.asset.fileName,
          relativePath: `assets/${output.asset.fileName}`,
          mimeType: output.asset.mimeType,
          width: output.asset.width,
          height: output.asset.height,
          cloudProvider: output.cloudStorage?.provider ?? null,
          cloudBucket: output.cloudStorage?.bucket ?? null,
          cloudRegion: output.cloudStorage?.region ?? null,
          cloudObjectKey: output.cloudStorage?.objectKey ?? null,
          cloudStatus: output.cloudStorage?.status ?? null,
          cloudError: output.cloudStorage?.error ?? null,
          cloudUploadedAt: output.cloudStorage?.uploadedAt ?? null,
          cloudEtag: output.cloudStorage?.etag ?? null,
          cloudRequestId: output.cloudStorage?.requestId ?? null,
          createdAt
        })
        .run();
    }

    db.insert(generationOutputs)
      .values({
        id: output.id,
        generationId,
        status: output.status,
        assetId: output.asset?.id ?? null,
        error: output.error ?? null,
        createdAt
      })
      .run();
  }

  return {
    id: generationId,
    mode: input.mode,
    prompt: input.originalPrompt,
    effectivePrompt: input.prompt,
    presetId: input.presetId,
    size: input.size,
    quality: input.quality,
    outputFormat: input.outputFormat,
    count: input.count,
    status,
    error,
    referenceAssetIds: referenceAssetIds.length > 0 ? referenceAssetIds : undefined,
    referenceAssetId: primaryReferenceAssetId,
    createdAt,
    outputs: outputs.map(toGenerationOutput)
  };
}

function resolveGenerationStatus(successCount: number, failureCount: number): GenerationStatus {
  if (successCount > 0 && failureCount > 0) {
    return "partial";
  }
  if (successCount > 0) {
    return "succeeded";
  }
  return "failed";
}

function toGenerationOutput(output: BatchOutputResult): GenerationOutput {
  return {
    id: output.id,
    status: output.status,
    asset: output.asset,
    error: output.error
  };
}

async function saveAssetToConfiguredCloud(input: {
  fileName: string;
  bytes: Buffer;
  mimeType: string;
  createdAt: string;
}): Promise<AssetCloudStorageRecord | undefined> {
  const config = getActiveCosStorageConfig();
  if (!config) {
    return undefined;
  }

  const objectKey = buildCosObjectKey(config.keyPrefix, input.fileName, input.createdAt);
  const adapter = new CosAssetStorageAdapter(config);

  try {
    const result = await adapter.putObject({
      key: objectKey,
      bytes: input.bytes,
      mimeType: input.mimeType
    });

    return {
      provider: "cos",
      bucket: config.bucket,
      region: config.region,
      objectKey,
      status: "uploaded",
      uploadedAt: new Date().toISOString(),
      etag: result.etag,
      requestId: result.requestId
    };
  } catch (error) {
    return {
      provider: "cos",
      bucket: config.bucket,
      region: config.region,
      objectKey,
      status: "failed",
      error: storageErrorMessage(error)
    };
  }
}

async function readCloudAsset(location: CosAssetLocation | undefined): Promise<Buffer | undefined> {
  const config = getActiveCosStorageConfig();
  if (!location || !config) {
    return undefined;
  }

  try {
    return await new CosAssetStorageAdapter(config).getObject(location);
  } catch {
    return undefined;
  }
}

function toCosAssetLocation(asset: typeof assets.$inferSelect): CosAssetLocation | undefined {
  if (
    asset.cloudProvider !== "cos" ||
    asset.cloudStatus !== "uploaded" ||
    !asset.cloudBucket ||
    !asset.cloudRegion ||
    !asset.cloudObjectKey
  ) {
    return undefined;
  }

  return {
    bucket: asset.cloudBucket,
    region: asset.cloudRegion,
    key: asset.cloudObjectKey
  };
}

function toGeneratedAssetCloud(cloudStorage: AssetCloudStorageRecord | undefined): GeneratedAssetCloudInfo | undefined {
  if (!cloudStorage) {
    return undefined;
  }

  return {
    provider: cloudStorage.provider,
    status: cloudStorage.status,
    lastError: cloudStorage.error,
    uploadedAt: cloudStorage.uploadedAt
  };
}

async function mapWithConcurrency<T, TResult>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<TResult>
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function errorToMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    return sanitizeGenerationErrorMessage(error.message);
  }
  if (error instanceof Error && error.message) {
    return sanitizeGenerationErrorMessage(error.message);
  }
  return "图像生成失败，请重试。";
}

function sanitizeGenerationErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "sk-[redacted]")
    .trim()
    .slice(0, 1200);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isInsideDirectory(filePath: string, directory: string): boolean {
  const localPath = relative(directory, filePath);
  return Boolean(localPath) && !localPath.startsWith("..") && !isAbsolute(localPath);
}
