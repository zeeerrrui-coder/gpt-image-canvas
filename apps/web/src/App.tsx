import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  ImageIcon,
  KeyRound,
  Loader2,
  LogOut,
  MapPin,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  X,
  XCircle
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Tldraw,
  type Editor,
  type TLAsset,
  type TLAssetContext,
  type TLAssetId,
  type TLAssetStore,
  type TLEditorSnapshot,
  type TLImageShape,
  type TLShapePartial,
  type TLShapeId,
  type TLStoreSnapshot,
  type TLComponents,
  type TldrawOptions,
  useIsDarkMode,
  useEditor,
  useValue
} from "tldraw";
import {
  GENERATION_PLACEHOLDER_TYPE,
  GenerationPlaceholderShapeUtil,
  type GenerationPlaceholderShape
} from "./GenerationPlaceholderShape";
import { HomePage } from "./HomePage";
import { ProviderConfigDialog } from "./ProviderConfigDialog";
import {
  CUSTOM_SIZE_PRESET_ID,
  GENERATION_COUNTS,
  IMAGE_QUALITIES,
  MAX_IMAGE_DIMENSION,
  MAX_REFERENCE_IMAGES,
  MIN_IMAGE_DIMENSION,
  OUTPUT_FORMATS,
  SIZE_PRESETS,
  STYLE_PRESETS,
  resolutionTierForSize,
  validateImageSize,
  type AuthStatusResponse,
  type AssetMetadataResponse,
  type CodexDevicePollResponse,
  type CodexDeviceStartResponse,
  type CodexLogoutResponse,
  type GalleryImageItem,
  type GenerationCount,
  type GenerationRecord,
  type GenerationResponse,
  type GenerationStatus,
  type GeneratedAsset,
  type ImageQuality,
  type ImageSize,
  type OutputFormat,
  type ProjectState,
  type ReferenceImageInput,
  type ResolutionTier,
  type SaveStorageConfigRequest,
  type SizePreset,
  type StorageConfigResponse,
  type StorageTestResult,
  type StylePresetId
} from "@gpt-image-canvas/shared";

const AUTOSAVE_DEBOUNCE_MS = 1200;
const HISTORY_COLLAPSED_LIMIT = 3;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const MOBILE_DRAWER_MEDIA_QUERY = "(max-width: 1023px)";
const ASSET_PREVIEW_WIDTHS = [256, 512, 1024, 2048] as const;
type AssetPreviewWidth = (typeof ASSET_PREVIEW_WIDTHS)[number];
const GENERATED_ASSET_INITIAL_PREVIEW_WIDTH: AssetPreviewWidth = 2048;
const SUPPORTED_REFERENCE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const initialCanvasPreviewWidths = new Map<string, AssetPreviewWidth>();
const assetMetadataCache = new Map<string, ImageSize>();
const assetMetadataRequests = new Map<string, Promise<ImageSize | undefined>>();
const RESOLUTION_BADGE_BASE_OFFSET = 7;
const RESOLUTION_BADGE_MIN_SCALE = 0.52;
const RESOLUTION_BADGE_SMALL_IMAGE_SIDE = 32;
const RESOLUTION_BADGE_FULL_SIZE_IMAGE_SIDE = 220;
const shapeUtils = [GenerationPlaceholderShapeUtil];
const tldrawOptions = {
  debouncedZoomThreshold: 80
} satisfies Partial<TldrawOptions>;
const TLDRAW_LICENSE_KEY =
  "tldraw-2026-08-08/WyJ3dGU4bldjRyIsWyIqIl0sMTYsIjIwMjYtMDgtMDgiXQ.Xt7lTydUhMnKfHfp+g8Mrs9gtJjlB8uPyYMniFEfRfruCYdYEl9J0uZl0lMAf6o7GdDB1zXOVhWLFAipssI6Cw";

const defaultStorageConfigForm: StorageConfigFormState = {
  enabled: false,
  secretId: "",
  secretKey: "",
  bucket: "source-1253253332",
  region: "ap-nanjing",
  keyPrefix: "gpt-image-canvas/assets"
};

const canvasAssetStore: TLAssetStore = {
  async upload(_asset, file) {
    return {
      src: await blobToDataUrl(file)
    };
  },
  resolve(asset, context) {
    return resolveCanvasAssetUrl(asset, context);
  }
};

const promptStarters = [
  {
    label: "产品海报",
    prompt: "一张高端护肤品产品海报，水面反光，精致布光，留出清晰标题空间"
  },
  {
    label: "室内空间",
    prompt: "一间安静的现代工作室，清晨自然光，木质家具，干净构图"
  },
  {
    label: "角色头像",
    prompt: "一个原创角色头像，温暖表情，清爽背景，细腻插画质感"
  },
  {
    label: "城市夜景",
    prompt: "未来城市夜景，雨后街道，霓虹倒影，电影感光影"
  }
] as const;
const quickSizePresetIds = new Set(["square-1k", "poster-portrait", "poster-landscape", "story-9-16", "video-16-9", "wide-2k"]);
const quickSizePresets = SIZE_PRESETS.filter((preset) => quickSizePresetIds.has(preset.id));
const PRIMARY_GENERATION_COUNTS: readonly GenerationCount[] = [1, 2, 4];
const EXTENDED_GENERATION_COUNTS: readonly GenerationCount[] = [8, 16];

type GalleryPageModule = { default: typeof import("./GalleryPage").GalleryPage };
let galleryPageModulePromise: Promise<GalleryPageModule> | undefined;

function loadGalleryPageModule(): Promise<GalleryPageModule> {
  galleryPageModulePromise ??= import("./GalleryPage").then((module) => ({ default: module.GalleryPage }));
  return galleryPageModulePromise;
}

const LazyGalleryPage = lazy(loadGalleryPageModule);

function preloadGalleryPage(): void {
  void loadGalleryPageModule();
}

type PersistedSnapshot = TLEditorSnapshot | TLStoreSnapshot;
type AppRoute = "home" | "canvas" | "gallery";
type SaveStatus = "loading" | "saved" | "pending" | "saving" | "error";
type GenerationMode = "text" | "reference";
type PanelStatusTone = "progress" | "success" | "warning" | "error";
type CodexLoginStatus = "idle" | "starting" | "pending" | "authorized" | "expired" | "denied" | "error";

interface PanelStatus {
  tone: PanelStatusTone;
  message: string;
  testId: "generation-progress" | "generation-message" | "generation-warning" | "validation-message" | "generation-error";
}

interface GenerationSubmitInput {
  prompt: string;
  presetId: StylePresetId;
  sizePresetId: string;
  size: {
    width: number;
    height: number;
  };
  quality: ImageQuality;
  outputFormat: OutputFormat;
  count: GenerationCount;
}

interface GenerationReferenceInput {
  referenceImages: ReferenceImageInput[];
  referenceAssetIds?: string[];
}

interface GenerationPlaceholderPlacement {
  id: TLShapeId;
  x: number;
  y: number;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
}

interface ActiveGenerationPlaceholders {
  requestId: number;
  placements: GenerationPlaceholderPlacement[];
}

interface ActiveGenerationTask {
  requestId: number;
  temporaryRecordId: string;
  controller: AbortController;
  placeholderSet: ActiveGenerationPlaceholders;
}

interface StorageConfigFormState {
  enabled: boolean;
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  keyPrefix: string;
}

interface ReferenceSelectionItem {
  assetId: TLAssetId | null;
  localAssetId?: string;
  name: string;
  sourceUrl: string;
  width: number;
  height: number;
}

type ReferenceSelection =
  | {
      status: "none" | "too-many" | "non-image" | "unreadable";
      hint: string;
    }
  | {
      status: "ready";
      references: ReferenceSelectionItem[];
      hint: string;
    };

const missingReferenceSelection: ReferenceSelection = {
  status: "none",
  hint: `选择画布中的 1-${MAX_REFERENCE_IMAGES} 张图片后，可用它们作为参考生成到画布。`
};

const qualityLabels: Record<ImageQuality, string> = {
  auto: "自动",
  low: "快速草稿",
  medium: "标准",
  high: "高质量"
};

const formatLabels: Record<OutputFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP"
};

const stylePresetLabels: Record<StylePresetId, string> = {
  none: "无风格",
  photoreal: "真实摄影",
  product: "商业产品",
  illustration: "精致插画",
  poster: "海报视觉",
  avatar: "头像角色"
};

const sizePresetLabels: Record<string, string> = {
  "square-1k": "方形成图 1K",
  "poster-portrait": "竖版海报",
  "poster-landscape": "横版海报",
  "story-9-16": "竖屏故事",
  "video-16-9": "视频封面",
  "wide-2k": "宽屏展示 2K",
  "portrait-2k": "高清竖图 2K",
  "square-2k": "高清方图 2K",
  "wide-4k": "宽屏展示 4K"
};

const modeLabels: Record<GenerationRecord["mode"], string> = {
  generate: "提示词到画布",
  edit: "参考图到画布"
};

const statusLabels: Record<GenerationStatus, string> = {
  pending: "等待中",
  running: "生成中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消"
};

const historyStatusStyles: Record<GenerationStatus, string> = {
  pending: "history-status--pending",
  running: "history-status--running",
  succeeded: "history-status--succeeded",
  partial: "history-status--partial",
  failed: "history-status--failed",
  cancelled: "history-status--cancelled"
};

function sizePresetLabel(preset: SizePreset): string {
  return sizePresetLabels[preset.id] ?? preset.label;
}

function sizePresetOptionLabel(preset: SizePreset): string {
  return `${sizePresetLabel(preset)} - ${preset.width} x ${preset.height}`;
}

function normalizeDimension(value: string): number {
  return Number.parseInt(value, 10);
}

function sizeValidationMessage(width: number, height: number): string {
  const result = validateImageSize({ width, height });

  if (result.ok) {
    return "";
  }

  return result.message;
}

function generationValidationMessage(promptValue: string, widthValue: number, heightValue: number): string {
  return promptValue.trim() ? sizeValidationMessage(widthValue, heightValue) : "请输入提示词。";
}

function routeFromLocation(): AppRoute {
  if (window.location.pathname === "/canvas") {
    return "canvas";
  }

  return window.location.pathname === "/gallery" ? "gallery" : "home";
}

function pathForRoute(route: AppRoute): string {
  if (route === "canvas") {
    return "/canvas";
  }

  return route === "gallery" ? "/gallery" : "/";
}

function isPersistedSnapshot(value: unknown): value is PersistedSnapshot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGenerationResponse(value: unknown): value is GenerationResponse {
  return typeof value === "object" && value !== null && "record" in value;
}

function failedOutputMessages(record: GenerationRecord): string[] {
  const seen = new Set<string>();
  const messages: string[] = [];

  for (const output of record.outputs) {
    if (output.status !== "failed") {
      continue;
    }

    const message = output.error?.trim();
    if (!message || seen.has(message)) {
      continue;
    }

    seen.add(message);
    messages.push(message);
  }

  return messages;
}

function generationFailureMessage(record: GenerationRecord): string {
  const summary = record.error?.trim();
  const firstFailure = failedOutputMessages(record)[0];

  if (firstFailure) {
    return summary && summary !== firstFailure ? `${summary} 失败原因：${firstFailure}` : firstFailure;
  }

  return summary || "没有可插入的成功图像。";
}

function generationWarningMessage(record: GenerationRecord, insertedCount: number, failedCount: number, cloudFailedCount: number): string {
  const parts = [`已向画布插入 ${insertedCount} 张图像`];
  if (failedCount > 0) {
    parts.push(`${failedCount} 张生成失败`);
  }
  if (cloudFailedCount > 0) {
    parts.push(`本地已保存，${cloudFailedCount} 张云端上传失败`);
  }

  const firstFailure = failedOutputMessages(record)[0];
  return firstFailure ? `${parts.join("，")}。失败原因：${firstFailure}` : `${parts.join("，")}。`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoadingGenerationPlaceholderRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.typeName === "shape" &&
    value.type === GENERATION_PLACEHOLDER_TYPE &&
    isRecord(value.props) &&
    value.props.status === "loading"
  );
}

function filterLoadingPlaceholdersFromStoreSnapshot<TSnapshot>(snapshot: TSnapshot): TSnapshot {
  if (!isRecord(snapshot) || !isRecord(snapshot.store)) {
    return snapshot;
  }

  let removed = false;
  const nextStore: Record<string, unknown> = {};
  for (const [id, record] of Object.entries(snapshot.store)) {
    if (isLoadingGenerationPlaceholderRecord(record)) {
      removed = true;
      continue;
    }

    nextStore[id] = record;
  }

  return removed ? ({ ...snapshot, store: nextStore } as TSnapshot) : snapshot;
}

function filterLoadingPlaceholdersFromSnapshot<TSnapshot>(snapshot: TSnapshot): TSnapshot {
  if (!isRecord(snapshot)) {
    return snapshot;
  }

  if (isRecord(snapshot.document)) {
    const document = filterLoadingPlaceholdersFromStoreSnapshot(snapshot.document);
    return document === snapshot.document ? snapshot : ({ ...snapshot, document } as TSnapshot);
  }

  return filterLoadingPlaceholdersFromStoreSnapshot(snapshot);
}

function coerceStylePresetId(value: string): StylePresetId {
  return STYLE_PRESETS.some((preset) => preset.id === value) ? (value as StylePresetId) : "none";
}

function coerceGenerationCount(value: number): GenerationCount {
  return GENERATION_COUNTS.includes(value as GenerationCount) ? (value as GenerationCount) : 1;
}

function sizePresetIdForSize(widthValue: number, heightValue: number): string {
  return (
    SIZE_PRESETS.find((preset) => preset.width === widthValue && preset.height === heightValue)?.id ?? CUSTOM_SIZE_PRESET_ID
  );
}

function firstDownloadableAsset(record: GenerationRecord): GeneratedAsset | undefined {
  return record.outputs.find((output) => output.status === "succeeded" && output.asset)?.asset;
}

function successfulOutputCount(record: GenerationRecord): number {
  return record.outputs.filter((output) => output.status === "succeeded" && output.asset).length;
}

function cloudFailureCount(record: GenerationRecord): number {
  return record.outputs.filter((output) => output.asset?.cloud?.status === "failed").length;
}

function firstCloudFailureMessage(record: GenerationRecord): string | undefined {
  return record.outputs.find((output) => output.asset?.cloud?.status === "failed")?.asset?.cloud?.lastError;
}

function generationModeToRecordMode(mode: GenerationMode): GenerationRecord["mode"] {
  return mode === "reference" ? "edit" : "generate";
}

function referenceAssetIdsForRecord(record: GenerationRecord): string[] {
  if (record.referenceAssetIds?.length) {
    return record.referenceAssetIds;
  }

  return record.referenceAssetId ? [record.referenceAssetId] : [];
}

function referenceAssetIdsForSelection(selection: Extract<ReferenceSelection, { status: "ready" }>): string[] | undefined {
  const referenceAssetIds = selection.references.map((reference) => reference.localAssetId);
  return referenceAssetIds.every((referenceAssetId): referenceAssetId is string => Boolean(referenceAssetId))
    ? referenceAssetIds
    : undefined;
}

function createTemporaryGenerationRecord(input: {
  requestId: number;
  submitInput: GenerationSubmitInput;
  requestMode: GenerationMode;
  referenceAssetIds?: string[];
  referenceAssetId?: string;
}): GenerationRecord {
  const promptValue = input.submitInput.prompt.trim();
  const referenceAssetIds = input.referenceAssetIds ?? (input.referenceAssetId ? [input.referenceAssetId] : undefined);

  return {
    id: `local-generation-${input.requestId}`,
    mode: generationModeToRecordMode(input.requestMode),
    prompt: promptValue,
    effectivePrompt: promptValue,
    presetId: input.submitInput.presetId,
    size: input.submitInput.size,
    quality: input.submitInput.quality,
    outputFormat: input.submitInput.outputFormat,
    count: input.submitInput.count,
    status: "running",
    referenceAssetIds,
    referenceAssetId: referenceAssetIds?.[0] ?? input.referenceAssetId,
    createdAt: new Date().toISOString(),
    outputs: []
  };
}

function promptExcerpt(promptValue: string): string {
  const compact = promptValue.replace(/\s+/gu, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 72)}...` : compact;
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.readOnly = true;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.append(textArea);
  textArea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Copy command was not accepted.");
    }
  } finally {
    textArea.remove();
  }
}

function formatCreatedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatCodexExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "15 分钟后";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function createTldrawAssetId(assetId: string): TLAssetId {
  return `asset:${assetId}` as TLAssetId;
}

function createTldrawShapeId(): TLShapeId {
  return `shape:${crypto.randomUUID()}` as TLShapeId;
}

function displaySize(size: ImageSize): { width: number; height: number } {
  const scale = Math.min(1, 340 / size.width, 300 / size.height);
  return {
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale)
  };
}

function createCenteredPlacements(editor: Editor, countValue: GenerationCount, size: ImageSize): GenerationPlaceholderPlacement[] {
  const placeholderSize = displaySize(size);
  const columns = countValue >= 8 ? 4 : countValue === 1 ? 1 : 2;
  const rows = Math.ceil(countValue / columns);
  const gap = 48;
  const cellWidth = placeholderSize.width;
  const cellHeight = placeholderSize.height;
  const gridWidth = columns * cellWidth + (columns - 1) * gap;
  const gridHeight = rows * cellHeight + (rows - 1) * gap;
  const viewport = editor.getViewportPageBounds();
  const originX = viewport.center.x - gridWidth / 2;
  const originY = viewport.center.y - gridHeight / 2;

  return Array.from({ length: countValue }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);

    return {
      id: createTldrawShapeId(),
      x: originX + column * (cellWidth + gap),
      y: originY + row * (cellHeight + gap),
      width: placeholderSize.width,
      height: placeholderSize.height,
      targetWidth: size.width,
      targetHeight: size.height
    };
  });
}

function createGenerationPlaceholders(
  editor: Editor,
  input: GenerationSubmitInput,
  requestId: number,
  options: { selectPlaceholders?: boolean } = {}
): ActiveGenerationPlaceholders {
  const placements = createCenteredPlacements(editor, input.count, input.size);
  const placeholderIds = placements.map((placement) => placement.id);

  editor.createShapes<GenerationPlaceholderShape>(
    placements.map((placement, index) => ({
      id: placement.id,
      type: GENERATION_PLACEHOLDER_TYPE,
      x: placement.x,
      y: placement.y,
      props: {
        w: placement.width,
        h: placement.height,
        targetWidth: placement.targetWidth,
        targetHeight: placement.targetHeight,
        status: "loading",
        error: "",
        requestId: String(requestId),
        outputIndex: index
      }
    }))
  );
  editor.bringToFront(placeholderIds);
  if (options.selectPlaceholders ?? true) {
    editor.select(...placeholderIds);
  }

  return {
    requestId,
    placements
  };
}

function isGenerationPlaceholderShape(shape: unknown): shape is GenerationPlaceholderShape {
  return isRecord(shape) && shape.type === GENERATION_PLACEHOLDER_TYPE;
}

function livePlacement(editor: Editor, placement: GenerationPlaceholderPlacement): GenerationPlaceholderPlacement {
  const shape = editor.getShape(placement.id);
  if (!isGenerationPlaceholderShape(shape)) {
    return placement;
  }

  return {
    ...placement,
    x: shape.x,
    y: shape.y,
    width: shape.props.w,
    height: shape.props.h
  };
}

function createImageAsset(asset: GeneratedAsset): TLAsset {
  initialCanvasPreviewWidths.set(asset.id, GENERATED_ASSET_INITIAL_PREVIEW_WIDTH);
  rememberAssetMetadata(asset.id, {
    width: asset.width,
    height: asset.height
  });

  return {
    id: createTldrawAssetId(asset.id),
    typeName: "asset",
    type: "image",
    props: {
      src: asset.url,
      w: asset.width,
      h: asset.height,
      name: asset.fileName,
      mimeType: asset.mimeType,
      isAnimated: false
    },
    meta: {
      localAssetId: asset.id
    }
  };
}

function createImageShape(
  asset: GeneratedAsset,
  placement: GenerationPlaceholderPlacement,
  promptValue: string
): Partial<TLImageShape> & { id: TLShapeId; type: "image" } {
  const assetId = createTldrawAssetId(asset.id);

  return {
    id: createTldrawShapeId(),
    type: "image",
    x: placement.x,
    y: placement.y,
    props: {
      assetId,
      w: placement.width,
      h: placement.height,
      url: asset.url,
      playing: true,
      crop: null,
      flipX: false,
      flipY: false,
      altText: promptValue
    }
  };
}

function replaceGenerationPlaceholders(editor: Editor, placeholderSet: ActiveGenerationPlaceholders, record: GenerationRecord): number {
  const assets: TLAsset[] = [];
  const imageShapes: Array<Partial<TLImageShape> & { id: TLShapeId; type: "image" }> = [];
  const replacedPlaceholderIds: TLShapeId[] = [];
  const failedUpdates: Array<TLShapePartial<GenerationPlaceholderShape>> = [];

  placeholderSet.placements.forEach((placement, index) => {
    const output = record.outputs[index];
    if (output?.status === "succeeded" && output.asset) {
      const resolvedPlacement = livePlacement(editor, placement);
      assets.push(createImageAsset(output.asset));
      imageShapes.push(createImageShape(output.asset, resolvedPlacement, record.prompt));
      if (isGenerationPlaceholderShape(editor.getShape(placement.id))) {
        replacedPlaceholderIds.push(placement.id);
      }
      return;
    }

    if (isGenerationPlaceholderShape(editor.getShape(placement.id))) {
      failedUpdates.push({
        id: placement.id,
        type: GENERATION_PLACEHOLDER_TYPE,
        props: {
          status: "failed",
          error: output?.error || record.error || "生成到画布失败。"
        }
      });
    }
  });

  editor.run(() => {
    if (replacedPlaceholderIds.length > 0) {
      editor.deleteShapes(replacedPlaceholderIds);
    }
    if (assets.length > 0) {
      editor.createAssets(assets);
    }
    if (imageShapes.length > 0) {
      editor.createShapes(imageShapes);
    }
    if (failedUpdates.length > 0) {
      editor.updateShapes<GenerationPlaceholderShape>(failedUpdates);
    }
  });

  if (imageShapes.length > 0) {
    editor.select(...imageShapes.map((shape) => shape.id));
  }

  return imageShapes.length;
}

function generatedAssetsForRecord(record: GenerationRecord): GeneratedAsset[] {
  return record.outputs.flatMap((output) => (output.status === "succeeded" && output.asset ? [output.asset] : []));
}

async function preloadGenerationRecordPreviews(record: GenerationRecord, signal: AbortSignal): Promise<void> {
  await Promise.all(generatedAssetsForRecord(record).map((asset) => preloadGeneratedAssetPreview(asset, signal)));
}

async function preloadGeneratedAssetPreview(asset: GeneratedAsset, signal: AbortSignal): Promise<void> {
  try {
    await preloadImageUrl(assetPreviewUrl(asset.id, GENERATED_ASSET_INITIAL_PREVIEW_WIDTH), signal);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
  }
}

function preloadImageUrl(url: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Image preload was aborted.", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";

    function cleanup(): void {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    }
    function complete(): void {
      cleanup();
      resolve();
    }
    function fail(): void {
      cleanup();
      reject(new Error(`Image preload failed for ${url}`));
    }
    function abort(): void {
      cleanup();
      image.src = "";
      reject(new DOMException("Image preload was aborted.", "AbortError"));
    }

    image.onload = complete;
    image.onerror = fail;
    signal.addEventListener("abort", abort, { once: true });
    image.src = url;
  });
}

function markGenerationPlaceholdersFailed(editor: Editor, placeholderSet: ActiveGenerationPlaceholders, error: string): void {
  const updates = placeholderSet.placements.flatMap((placement) => {
    const shape = editor.getShape(placement.id);
    if (!isGenerationPlaceholderShape(shape) || shape.props.status !== "loading") {
      return [];
    }

    return [
      {
        id: placement.id,
        type: GENERATION_PLACEHOLDER_TYPE,
        props: {
          status: "failed",
          error
        }
      } satisfies TLShapePartial<GenerationPlaceholderShape>
    ];
  });

  if (updates.length > 0) {
    editor.updateShapes<GenerationPlaceholderShape>(updates);
  }
}

function deleteLoadingGenerationPlaceholders(editor: Editor, placeholderSet: ActiveGenerationPlaceholders): void {
  const loadingPlaceholderIds = placeholderSet.placements.flatMap((placement) => {
    const shape = editor.getShape(placement.id);
    return isGenerationPlaceholderShape(shape) && shape.props.status === "loading" ? [placement.id] : [];
  });

  if (loadingPlaceholderIds.length > 0) {
    editor.deleteShapes(loadingPlaceholderIds);
  }
}

function firstLiveGenerationPlaceholder(editor: Editor, placeholderSet: ActiveGenerationPlaceholders): TLShapeId | undefined {
  return placeholderSet.placements.find((placement) => isGenerationPlaceholderShape(editor.getShape(placement.id)))?.id;
}

function resolveReferenceSelection(editor: Editor): ReferenceSelection {
  const selectedShapes = editor.getSelectedShapes();

  if (selectedShapes.length === 0) {
    return missingReferenceSelection;
  }

  if (selectedShapes.some((shape) => shape.type !== "image")) {
    return {
      status: "non-image",
      hint: `当前选择中包含非图片对象。请只圈选 1-${MAX_REFERENCE_IMAGES} 张图片作为参考。`
    };
  }

  if (selectedShapes.length > MAX_REFERENCE_IMAGES) {
    return {
      status: "too-many",
      hint: `当前选择了 ${selectedShapes.length} 张图片。参考图最多支持 ${MAX_REFERENCE_IMAGES} 张。`
    };
  }

  const references: Array<ReferenceSelectionItem & { sortX: number; sortY: number }> = [];
  for (const shape of selectedShapes) {
    const imageShape = shape as TLImageShape;
    const asset = imageShape.props.assetId ? editor.getAsset(imageShape.props.assetId) : undefined;
    const sourceUrl = getImageSourceUrl(imageShape, asset);

    if (!sourceUrl) {
      return {
        status: "unreadable",
        hint: "选中的图片缺少可读取的数据源，无法作为参考图。"
      };
    }

    if (!isReadableReferenceSource(sourceUrl, asset)) {
      return {
        status: "unreadable",
        hint: "选中的图片当前无法被浏览器读取，请只选择本地生成或已导入的 PNG、JPEG、WebP 图片。"
      };
    }

    const bounds = editor.getShapePageBounds(imageShape);
    references.push({
      assetId: imageShape.props.assetId,
      localAssetId: getLocalAssetId(asset, sourceUrl),
      name: getReferenceName(asset, sourceUrl),
      sourceUrl,
      width: asset?.type === "image" ? asset.props.w : imageShape.props.w,
      height: asset?.type === "image" ? asset.props.h : imageShape.props.h,
      sortX: bounds?.x ?? 0,
      sortY: bounds?.y ?? 0
    });
  }

  const sortedReferences = references
    .sort((left, right) => (left.sortY === right.sortY ? left.sortX - right.sortX : left.sortY - right.sortY))
    .map(({ sortX: _sortX, sortY: _sortY, ...reference }) => reference);

  return {
    status: "ready",
    references: sortedReferences,
    hint:
      sortedReferences.length === 1
        ? "已选中 1 张图片，将使用它作为本次参考图。"
        : `已选中 ${sortedReferences.length} 张参考图，将按画布位置从上到下、从左到右发送。`
  };
}

function areReferenceSelectionsEqual(left: ReferenceSelection, right: ReferenceSelection): boolean {
  if (left.status !== right.status) {
    return false;
  }

  if (left.status !== "ready" || right.status !== "ready") {
    return left.hint === right.hint;
  }

  return (
    left.hint === right.hint &&
    left.references.length === right.references.length &&
    left.references.every((leftReference, index) => {
      const rightReference = right.references[index];
      return (
        rightReference !== undefined &&
        leftReference.assetId === rightReference.assetId &&
        leftReference.localAssetId === rightReference.localAssetId &&
        leftReference.name === rightReference.name &&
        leftReference.sourceUrl === rightReference.sourceUrl &&
        leftReference.width === rightReference.width &&
        leftReference.height === rightReference.height
      );
    })
  );
}

function getImageSourceUrl(shape: TLImageShape, asset: TLAsset | undefined): string | undefined {
  const assetSrc = asset?.type === "image" && typeof asset.props.src === "string" ? asset.props.src : undefined;
  return assetSrc || shape.props.url || undefined;
}

function getAssetMimeType(asset: TLAsset | undefined): string | undefined {
  return asset?.type === "image" && typeof asset.props.mimeType === "string" ? asset.props.mimeType : undefined;
}

function isReadableReferenceSource(sourceUrl: string, asset: TLAsset | undefined): boolean {
  const assetMimeType = getAssetMimeType(asset);
  if (assetMimeType && !isSupportedReferenceImageType(assetMimeType)) {
    return false;
  }

  if (sourceUrl.startsWith("data:")) {
    const mimeType = /^data:([^;,]+)/iu.exec(sourceUrl)?.[1];
    return Boolean(mimeType && isSupportedReferenceImageType(mimeType));
  }

  if (sourceUrl.startsWith("blob:")) {
    return true;
  }

  try {
    return new URL(sourceUrl, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

function getReferenceName(asset: TLAsset | undefined, sourceUrl: string): string {
  if (asset?.type === "image" && asset.props.name) {
    return asset.props.name;
  }

  try {
    const pathname = new URL(sourceUrl, window.location.origin).pathname;
    return pathname.split("/").filter(Boolean).at(-1) || "reference-image";
  } catch {
    return "reference-image";
  }
}

function getLocalAssetId(asset: TLAsset | undefined, sourceUrl?: string): string | undefined {
  const localAssetId = asset?.meta && typeof asset.meta.localAssetId === "string" ? asset.meta.localAssetId : undefined;
  if (localAssetId) {
    return localAssetId;
  }

  if (!sourceUrl) {
    return undefined;
  }

  try {
    const url = new URL(sourceUrl, window.location.origin);
    if (url.origin === window.location.origin) {
      const match = /^\/api\/assets\/([^/?#]+)(?:\/download)?$/u.exec(url.pathname);
      return match?.[1];
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveCanvasAssetUrl(asset: TLAsset, context: TLAssetContext): string | null {
  if (asset.type !== "image") {
    return "src" in asset.props && typeof asset.props.src === "string" ? asset.props.src : null;
  }

  const sourceUrl = asset.props.src;
  if (!sourceUrl || context.shouldResolveToOriginal) {
    return sourceUrl || null;
  }

  const localAssetId = getLocalAssetId(asset, sourceUrl);
  if (!localAssetId) {
    return sourceUrl;
  }

  const previewWidth = Math.max(
    previewWidthForAssetContext(asset, context),
    initialCanvasPreviewWidths.get(localAssetId) ?? ASSET_PREVIEW_WIDTHS[0]
  );
  return assetPreviewUrl(localAssetId, previewWidth);
}

function assetPreviewUrl(assetId: string, width: number): string {
  return `/api/assets/${encodeURIComponent(assetId)}/preview?width=${width}`;
}

function previewWidthForAssetContext(asset: Extract<TLAsset, { type: "image" }>, context: TLAssetContext): AssetPreviewWidth {
  const dpr = Number.isFinite(context.dpr) && context.dpr > 0 ? context.dpr : window.devicePixelRatio || 1;
  const requestedWidth = Math.max(1, Math.ceil(asset.props.w * context.screenScale * dpr));
  return ASSET_PREVIEW_WIDTHS.find((widthValue) => widthValue >= requestedWidth) ?? ASSET_PREVIEW_WIDTHS[ASSET_PREVIEW_WIDTHS.length - 1];
}

interface CanvasResolutionBadgeTarget {
  localAssetId?: string;
  fallbackSize: ImageSize;
  badgeScale: number;
  screenX: number;
  screenY: number;
}

interface ClientPoint {
  x: number;
  y: number;
}

function CanvasResolutionBadgeOverlay() {
  const editor = useEditor();
  const pointerClientPoint = usePointerClientPoint(editor);
  const target = useValue("canvas resolution badge target", () => getCanvasResolutionBadgeTarget(editor, pointerClientPoint), [
    editor,
    pointerClientPoint?.x,
    pointerClientPoint?.y
  ]);
  const [loadedMetadata, setLoadedMetadata] = useState<{ assetId: string; size: ImageSize } | undefined>();

  const localAssetId = target?.localAssetId;
  const cachedMetadata = localAssetId ? assetMetadataCache.get(localAssetId) : undefined;
  const loadedSize = loadedMetadata && loadedMetadata.assetId === localAssetId ? loadedMetadata.size : undefined;
  const resolvedSize = localAssetId ? (cachedMetadata ?? loadedSize) : target?.fallbackSize;

  useEffect(() => {
    if (!localAssetId || assetMetadataCache.has(localAssetId)) {
      return;
    }

    let isActive = true;
    void fetchAssetMetadata(localAssetId).then((size) => {
      if (isActive && size) {
        setLoadedMetadata({ assetId: localAssetId, size });
      }
    });

    return () => {
      isActive = false;
    };
  }, [localAssetId]);

  if (!target || !resolvedSize) {
    return null;
  }

  const tier: ResolutionTier = resolutionTierForSize(resolvedSize);

  return (
    <span
      aria-hidden="true"
      className="canvas-resolution-badge"
      data-resolution-tier={tier}
      data-testid="canvas-resolution-badge"
      style={{
        transform: `translate3d(${Math.round(target.screenX + resolutionBadgeOffset(target.badgeScale))}px, ${Math.round(
          target.screenY + resolutionBadgeOffset(target.badgeScale)
        )}px, 0) scale(${target.badgeScale})`
      }}
    >
      {tier}
    </span>
  );
}

function usePointerClientPoint(editor: Editor): ClientPoint | undefined {
  const [point, setPoint] = useState<ClientPoint | undefined>();
  const frameRef = useRef<number | undefined>();
  const latestPointRef = useRef<ClientPoint | undefined>();

  useEffect(() => {
    const ownerWindow = editor.getContainer().ownerDocument.defaultView ?? window;

    const updatePoint = (nextPoint: ClientPoint | undefined) => {
      latestPointRef.current = nextPoint;
      if (frameRef.current !== undefined) {
        return;
      }

      frameRef.current = ownerWindow.requestAnimationFrame(() => {
        frameRef.current = undefined;
        setPoint(latestPointRef.current);
      });
    };

    const handlePointerMove = (event: PointerEvent) => {
      updatePoint({
        x: event.clientX,
        y: event.clientY
      });
    };
    const handlePointerLeave = () => updatePoint(undefined);

    ownerWindow.addEventListener("pointermove", handlePointerMove, { passive: true });
    ownerWindow.addEventListener("pointerleave", handlePointerLeave);
    ownerWindow.addEventListener("blur", handlePointerLeave);

    return () => {
      ownerWindow.removeEventListener("pointermove", handlePointerMove);
      ownerWindow.removeEventListener("pointerleave", handlePointerLeave);
      ownerWindow.removeEventListener("blur", handlePointerLeave);
      if (frameRef.current !== undefined) {
        ownerWindow.cancelAnimationFrame(frameRef.current);
      }
    };
  }, [editor]);

  return point;
}

function getCanvasResolutionBadgeTarget(editor: Editor, pointerClientPoint: ClientPoint | undefined): CanvasResolutionBadgeTarget | undefined {
  const imageShape = getImageShapeUnderPointer(editor, pointerClientPoint);
  if (!imageShape) {
    return undefined;
  }

  const bounds = editor.getShapePageBounds(imageShape);
  if (!bounds) {
    return undefined;
  }

  const asset = imageShape.props.assetId ? editor.getAsset(imageShape.props.assetId) : undefined;
  const sourceUrl = getImageSourceUrl(imageShape, asset);
  const localAssetId = getLocalAssetId(asset, sourceUrl);
  const topLeft = editor.pageToScreen({ x: bounds.x, y: bounds.y });
  const bottomRight = editor.pageToScreen({ x: bounds.x + bounds.w, y: bounds.y + bounds.h });
  const containerRect = editor.getContainer().getBoundingClientRect();
  const screenWidth = Math.abs(bottomRight.x - topLeft.x);
  const screenHeight = Math.abs(bottomRight.y - topLeft.y);

  return {
    localAssetId,
    fallbackSize: fallbackImageSize(imageShape, asset),
    badgeScale: resolutionBadgeScale(screenWidth, screenHeight, containerRect.width),
    screenX: topLeft.x - containerRect.left,
    screenY: topLeft.y - containerRect.top
  };
}

function resolutionBadgeScale(screenWidth: number, screenHeight: number, canvasWidth: number): number {
  const imageShortSide = Math.max(0, Math.min(screenWidth, screenHeight));
  const imageScale =
    imageShortSide >= RESOLUTION_BADGE_FULL_SIZE_IMAGE_SIDE
      ? 1
      : RESOLUTION_BADGE_MIN_SCALE +
        ((Math.max(imageShortSide, RESOLUTION_BADGE_SMALL_IMAGE_SIDE) - RESOLUTION_BADGE_SMALL_IMAGE_SIDE) /
          (RESOLUTION_BADGE_FULL_SIZE_IMAGE_SIDE - RESOLUTION_BADGE_SMALL_IMAGE_SIDE)) *
          (1 - RESOLUTION_BADGE_MIN_SCALE);
  const canvasScale = canvasWidth < 520 ? 0.78 : canvasWidth < 760 ? 0.88 : 1;

  return Math.max(RESOLUTION_BADGE_MIN_SCALE, Math.min(1, imageScale, canvasScale));
}

function resolutionBadgeOffset(scale: number): number {
  return Math.max(4, RESOLUTION_BADGE_BASE_OFFSET * scale);
}

function getImageShapeUnderPointer(editor: Editor, pointerClientPoint: ClientPoint | undefined): TLImageShape | undefined {
  if (!pointerClientPoint || !isPointerOverCanvas(editor, pointerClientPoint)) {
    return undefined;
  }

  const shapeAtPoint = editor.getShapeAtPoint(editor.screenToPage(pointerClientPoint), {
    hitInside: true,
    renderingOnly: true,
    filter: (shape) => shape.type === "image"
  });

  return shapeAtPoint?.type === "image" ? (shapeAtPoint as TLImageShape) : undefined;
}

function isPointerOverCanvas(editor: Editor, pointerClientPoint: ClientPoint): boolean {
  const target = editor.getContainer().ownerDocument.elementFromPoint(pointerClientPoint.x, pointerClientPoint.y);
  return Boolean(target?.closest(".tl-canvas"));
}

function fallbackImageSize(imageShape: TLImageShape, asset: TLAsset | undefined): ImageSize {
  if (asset?.type === "image" && isUsableImageSize(asset.props)) {
    return {
      width: asset.props.w,
      height: asset.props.h
    };
  }

  return {
    width: imageShape.props.w,
    height: imageShape.props.h
  };
}

function isUsableImageSize(size: { width?: unknown; height?: unknown; w?: unknown; h?: unknown }): boolean {
  const width = typeof size.width === "number" ? size.width : size.w;
  const height = typeof size.height === "number" ? size.height : size.h;
  return typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function rememberAssetMetadata(assetId: string, size: ImageSize): void {
  if (isUsableImageSize(size)) {
    assetMetadataCache.set(assetId, size);
  }
}

async function fetchAssetMetadata(assetId: string): Promise<ImageSize | undefined> {
  const cached = assetMetadataCache.get(assetId);
  if (cached) {
    return cached;
  }

  const existingRequest = assetMetadataRequests.get(assetId);
  if (existingRequest) {
    return existingRequest;
  }

  const request = fetch(`/api/assets/${encodeURIComponent(assetId)}/metadata`)
    .then(async (response) => {
      if (!response.ok) {
        return undefined;
      }

      const body = (await response.json()) as AssetMetadataResponse;
      const size = {
        width: body.width,
        height: body.height
      };

      if (body.id !== assetId || !isUsableImageSize(size)) {
        return undefined;
      }

      rememberAssetMetadata(assetId, size);
      return size;
    })
    .catch(() => undefined)
    .finally(() => {
      assetMetadataRequests.delete(assetId);
    });

  assetMetadataRequests.set(assetId, request);
  return request;
}

function findCanvasImageShape(editor: Editor, record: GenerationRecord): TLShapeId | undefined {
  const assetIds = new Set(
    record.outputs.flatMap((output) => (output.status === "succeeded" && output.asset ? [output.asset.id] : []))
  );
  if (assetIds.size === 0) {
    return undefined;
  }

  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== "image") {
      continue;
    }

    const imageShape = shape as TLImageShape;
    const asset = imageShape.props.assetId ? editor.getAsset(imageShape.props.assetId) : undefined;
    const sourceUrl = getImageSourceUrl(imageShape, asset);
    const localAssetId = getLocalAssetId(asset, sourceUrl);

    if (localAssetId && assetIds.has(localAssetId)) {
      return imageShape.id;
    }
  }

  return undefined;
}

function fileNameWithImageExtension(name: string, mimeType: string): string {
  if (/\.(png|jpe?g|webp|gif)$/iu.test(name)) {
    return name;
  }

  const extension = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return `${name}.${extension}`;
}

function isSupportedReferenceImageType(mimeType: string): boolean {
  return SUPPORTED_REFERENCE_MIME_TYPES.has(mimeType.toLowerCase());
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取参考图片数据。"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("无法读取参考图片数据。"));
    };
    reader.readAsDataURL(blob);
  });
}

async function readReferenceImage(selection: ReferenceSelectionItem, signal: AbortSignal): Promise<{
  dataUrl: string;
  fileName: string;
}> {
  let response: Response;

  try {
    response = await fetch(selection.sourceUrl, { signal });
  } catch {
    throw new Error("无法读取当前参考图。请确认图片来自本地生成结果或浏览器可访问的图片数据。");
  }

  if (!response.ok) {
    throw new Error("无法读取当前参考图。请确认图片文件仍然存在。");
  }

  const blob = await response.blob();
  if (!isSupportedReferenceImageType(blob.type)) {
    throw new Error("当前参考资源不是可用的图片格式。");
  }
  if (blob.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("参考图像不能超过 50MB。");
  }

  return {
    dataUrl: await blobToDataUrl(blob),
    fileName: fileNameWithImageExtension(selection.name, blob.type)
  };
}

async function readStoredReferenceImage(assetId: string, signal: AbortSignal): Promise<ReferenceImageInput> {
  const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}`, { signal });
  if (!response.ok) {
    throw new Error("无法读取历史参考图。请确认原始资源仍然存在。");
  }

  const blob = await response.blob();
  if (!isSupportedReferenceImageType(blob.type)) {
    throw new Error("历史参考资源不是可用的图片格式。");
  }
  if (blob.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("历史参考图像不能超过 50MB。");
  }

  return {
    dataUrl: await blobToDataUrl(blob),
    fileName: fileNameWithImageExtension(assetId, blob.type)
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ? `${body.error.message}（HTTP ${response.status}）` : `生成请求失败，状态 ${response.status}。`;
  } catch {
    return `生成请求失败，状态 ${response.status}。`;
  }
}

function storageConfigToForm(config: StorageConfigResponse | null): StorageConfigFormState {
  if (!config) {
    return defaultStorageConfigForm;
  }

  return {
    enabled: config.enabled,
    secretId: config.cos.secretId,
    secretKey: config.cos.secretKey.value ?? "",
    bucket: config.cos.bucket,
    region: config.cos.region,
    keyPrefix: config.cos.keyPrefix
  };
}

function storageConfigRequestBody(
  form: StorageConfigFormState,
  options: { preserveSecret: boolean; forceEnabled?: boolean }
): SaveStorageConfigRequest {
  return {
    enabled: options.forceEnabled ?? form.enabled,
    provider: "cos",
    cos: {
      secretId: form.secretId.trim(),
      secretKey: options.preserveSecret ? undefined : form.secretKey,
      preserveSecret: options.preserveSecret,
      bucket: form.bucket.trim(),
      region: form.region.trim(),
      keyPrefix: form.keyPrefix.trim()
    }
  };
}

function requestGenerationNotificationPermission(): void {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "default") {
    return;
  }

  void Notification.requestPermission().catch(() => undefined);
}

function showGenerationCompleteNotification(record: GenerationRecord, insertedCount: number, failedCount: number): void {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const isPartial = record.status === "partial" || failedCount > 0;
  const body = isPartial
    ? `已向画布插入 ${insertedCount} 张图像，${failedCount} 张失败。`
    : `已向画布插入 ${insertedCount} 张图像。`;

  new Notification(isPartial ? "生成到画布部分完成" : "已生成到画布", {
    body,
    icon: "/favicon.svg",
    tag: `generation-${record.id}`
  });
}

function saveStatusLabel(status: SaveStatus): string {
  switch (status) {
    case "loading":
      return "正在载入";
    case "pending":
      return "待保存";
    case "saving":
      return "保存中";
    case "error":
      return "保存失败";
    case "saved":
    default:
      return "已保存";
  }
}

function SaveStatusIcon({ status }: { status: SaveStatus }) {
  if (status === "saving" || status === "loading") {
    return <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />;
  }

  if (status === "error") {
    return <AlertTriangle className="size-3.5" aria-hidden="true" />;
  }

  if (status === "saved") {
    return <CheckCircle2 className="size-3.5" aria-hidden="true" />;
  }

  return <Cloud className="size-3.5" aria-hidden="true" />;
}

function BrandMark({ className = "" }: { className?: string }) {
  return (
    <span className={`brand-mark ${className}`} aria-hidden="true">
      <span className="brand-mark__aperture" />
      <span className="brand-mark__spark" />
    </span>
  );
}

function BrandName() {
  return (
    <p className="brand-name" title="gpt-image-canvas">
      <span className="brand-name__prefix">gpt</span>
      <span className="brand-name__dash">-</span>
      <span className="brand-name__image">image</span>
      <span className="brand-name__dash">-</span>
      <span className="brand-name__canvas">canvas</span>
    </p>
  );
}

function TopNavigation({
  onOpenProviderConfig,
  route,
  onNavigate,
  onPreloadGallery
}: {
  onOpenProviderConfig: () => void;
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
  onPreloadGallery: () => void;
}) {
  return (
    <header className="top-navigation">
      <div className="top-navigation__inner">
        <div className="brand-lockup min-w-0">
          <BrandMark />
          <div className="min-w-0">
            <BrandName />
            <p className="brand-tagline">本地 AI 图像画布</p>
          </div>
        </div>
        <div className="top-navigation__actions">
          <nav aria-label="主要页面" className="top-navigation__links">
            <a
              aria-current={route === "home" ? "page" : undefined}
              className="top-navigation__link"
              data-active={route === "home"}
              data-testid="nav-home"
              href="/"
              onClick={(event) => {
                event.preventDefault();
                onNavigate("home");
              }}
            >
              <Sparkles className="size-4" aria-hidden="true" />
              首页
            </a>
            <a
              aria-current={route === "canvas" ? "page" : undefined}
              className="top-navigation__link"
              data-active={route === "canvas"}
              data-testid="nav-canvas"
              href="/canvas"
              onClick={(event) => {
                event.preventDefault();
                onNavigate("canvas");
              }}
            >
              <Square className="size-4" aria-hidden="true" />
              画布
            </a>
            <a
              aria-current={route === "gallery" ? "page" : undefined}
              className="top-navigation__link"
              data-active={route === "gallery"}
              data-testid="nav-gallery"
              href="/gallery"
              onFocus={onPreloadGallery}
              onMouseEnter={onPreloadGallery}
              onClick={(event) => {
                event.preventDefault();
                onNavigate("gallery");
              }}
            >
              <ImageIcon className="size-4" aria-hidden="true" />
              Gallery
            </a>
          </nav>
          <button
            aria-label="打开生成服务配置"
            className="top-navigation__settings"
            data-testid="global-provider-settings"
            title="生成服务配置"
            type="button"
            onClick={onOpenProviderConfig}
          >
            <Settings className="size-4" aria-hidden="true" />
            <span>配置</span>
          </button>
        </div>
      </div>
    </header>
  );
}

function CanvasThemeSync({ onChange }: { onChange: (isDarkMode: boolean) => void }) {
  const isDarkMode = useIsDarkMode();

  useEffect(() => {
    onChange(isDarkMode);
  }, [isDarkMode, onChange]);

  return null;
}

function providerStatusDetails(authStatus: AuthStatusResponse | null, isAuthLoading: boolean): {
  copy: string;
  provider: "openai" | "codex" | "loading" | "none";
  title: string;
} {
  if (authStatus?.provider === "openai") {
    if (authStatus.activeSource?.id === "local-openai") {
      return {
        copy: "当前使用应用内保存的 OpenAI 兼容配置。",
        provider: "openai",
        title: "本地 OpenAI"
      };
    }

    if (authStatus.activeSource?.id === "env-openai") {
      return {
        copy: "当前使用 .env 或运行时环境变量中的 OpenAI 兼容配置。",
        provider: "openai",
        title: "环境 OpenAI"
      };
    }

    return {
      copy: "当前使用 OpenAI 兼容 Images API。",
      provider: "openai",
      title: "OpenAI API"
    };
  }

  if (authStatus?.provider === "codex") {
    return {
      copy: authStatus.codex.email ?? authStatus.codex.accountId ?? "Codex 会话可用。",
      provider: "codex",
      title: "Codex 已登录"
    };
  }

  if (isAuthLoading) {
    return {
      copy: "正在检查本地凭据。",
      provider: "loading",
      title: "检查登录状态"
    };
  }

  return {
    copy: "打开右上角配置，可保存本地 API 或登录 Codex。",
    provider: "none",
    title: "需要生成服务"
  };
}

function ProviderStatusPopover({
  authError,
  authStatus,
  codexLoginStatus,
  isAuthLoading,
  onLogoutCodex,
  onStartCodexLogin
}: {
  authError: string;
  authStatus: AuthStatusResponse | null;
  codexLoginStatus: CodexLoginStatus;
  isAuthLoading: boolean;
  onLogoutCodex: () => void;
  onStartCodexLogin: () => void;
}) {
  const details = providerStatusDetails(authStatus, isAuthLoading);
  const isCodexStarting = codexLoginStatus === "starting";

  return (
    <div className="provider-status-popover" data-provider={details.provider} data-testid="auth-provider-card">
      <button
        aria-label={`图像服务：${details.title}`}
        className="provider-status-popover__trigger"
        type="button"
      >
        {details.provider === "openai" || details.provider === "codex" ? (
          <ShieldCheck className="size-4" aria-hidden="true" />
        ) : details.provider === "loading" ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <KeyRound className="size-4" aria-hidden="true" />
        )}
      </button>

      <div className="provider-status-popover__content">
        <span className="control-label">图像服务</span>
        <p className="provider-status-popover__title">{details.title}</p>
        <p className="provider-status-popover__copy">{details.copy}</p>

        {authError ? (
          <p className="provider-status-popover__error" role="alert">
            {authError}
          </p>
        ) : null}

        {details.provider === "codex" ? (
          <button
            className="provider-status-popover__action"
            type="button"
            title="退出 Codex"
            data-testid="codex-logout-button"
            disabled={isAuthLoading}
            onClick={onLogoutCodex}
          >
            <LogOut className="size-4" aria-hidden="true" />
            退出 Codex
          </button>
        ) : details.provider === "openai" ? null : (
          <button
            className="provider-status-popover__action"
            type="button"
            data-testid="codex-login-button"
            disabled={isAuthLoading || isCodexStarting}
            onClick={onStartCodexLogin}
          >
            {isCodexStarting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <KeyRound className="size-4" aria-hidden="true" />
            )}
            登录 Codex
          </button>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => routeFromLocation());
  const shouldAutoOpenCanvasRef = useRef(route !== "gallery");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("text");
  const [prompt, setPrompt] = useState("");
  const [stylePreset, setStylePreset] = useState<StylePresetId>("none");
  const [sizePresetId, setSizePresetId] = useState(SIZE_PRESETS[0].id);
  const [width, setWidth] = useState(SIZE_PRESETS[0].width);
  const [height, setHeight] = useState(SIZE_PRESETS[0].height);
  const [count, setCount] = useState<GenerationCount>(1);
  const [quality, setQuality] = useState<ImageQuality>("auto");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("png");
  const [activeGenerationCount, setActiveGenerationCount] = useState(0);
  const [isProjectLoaded, setIsProjectLoaded] = useState(false);
  const [projectSnapshot, setProjectSnapshot] = useState<PersistedSnapshot | undefined>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [saveError, setSaveError] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [generationMessage, setGenerationMessage] = useState("");
  const [generationWarning, setGenerationWarning] = useState("");
  const [generationHistory, setGenerationHistory] = useState<GenerationRecord[]>([]);
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const [isMobileDrawer, setIsMobileDrawer] = useState(false);
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const [isStorageDialogOpen, setIsStorageDialogOpen] = useState(false);
  const [isProviderConfigDialogOpen, setIsProviderConfigDialogOpen] = useState(false);
  const [storageConfig, setStorageConfig] = useState<StorageConfigResponse | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [isCodexLoginOpen, setIsCodexLoginOpen] = useState(false);
  const [codexDevice, setCodexDevice] = useState<CodexDeviceStartResponse | null>(null);
  const [codexLoginStatus, setCodexLoginStatus] = useState<CodexLoginStatus>("idle");
  const [codexLoginMessage, setCodexLoginMessage] = useState("");
  const [storageForm, setStorageForm] = useState<StorageConfigFormState>(defaultStorageConfigForm);
  const [storageSecretTouched, setStorageSecretTouched] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [storageMessage, setStorageMessage] = useState("");
  const [isStorageSaving, setIsStorageSaving] = useState(false);
  const [isStorageTesting, setIsStorageTesting] = useState(false);
  const [referenceSelection, setReferenceSelection] = useState<ReferenceSelection>(missingReferenceSelection);
  const [isCanvasDarkMode, setIsCanvasDarkMode] = useState(false);
  const canvasShellRef = useRef<HTMLElement | null>(null);
  const panelCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const generationModeRef = useRef<GenerationMode>("text");
  const activeGenerationsRef = useRef<Map<number, ActiveGenerationTask>>(new Map());
  const generationRequestRef = useRef(0);
  const saveTimerRef = useRef<number | undefined>();
  const codexPollTimerRef = useRef<number | undefined>();
  const saveRequestRef = useRef(0);
  const isGenerating = activeGenerationCount > 0;
  const hasGenerationProvider = authStatus?.provider === "openai" || authStatus?.provider === "codex";

  const trimmedPrompt = prompt.trim();
  const promptValidationMessage = prompt.trim() ? "" : "请输入提示词。";
  const dimensionValidationMessage = sizeValidationMessage(width, height);
  const isReferenceMode = generationMode === "reference";
  const isReferenceReady = isReferenceMode && referenceSelection.status === "ready";
  const referenceValidationMessage = isReferenceMode && !isReferenceReady ? referenceSelection.hint : "";
  const validationMessage = promptValidationMessage || dimensionValidationMessage || referenceValidationMessage;
  const shouldShowValidation = Boolean(validationMessage);
  const canGenerate = !validationMessage;
  const tldrawComponents = useMemo(
    () =>
      ({
        InFrontOfTheCanvas: () => (
          <>
            <CanvasThemeSync onChange={setIsCanvasDarkMode} />
            <CanvasResolutionBadgeOverlay />
          </>
        ),
        StylePanel: null
      }) satisfies TLComponents,
    []
  );

  const navigateToRoute = useCallback((nextRoute: AppRoute, options: { replace?: boolean } = {}): void => {
    if (!options.replace) {
      shouldAutoOpenCanvasRef.current = false;
    }

    const nextPath = pathForRoute(nextRoute);
    if (window.location.pathname !== nextPath) {
      if (options.replace) {
        window.history.replaceState(null, "", nextPath);
      } else {
        window.history.pushState(null, "", nextPath);
      }
    }
    setRoute(nextRoute);
  }, []);

  const visibleHistory = useMemo(
    () => (isHistoryExpanded ? generationHistory : generationHistory.slice(0, HISTORY_COLLAPSED_LIMIT)),
    [generationHistory, isHistoryExpanded]
  );
  const hiddenHistoryCount = Math.max(0, generationHistory.length - HISTORY_COLLAPSED_LIMIT);
  const hasAdditionalHistory = hiddenHistoryCount > 0;
  const isExtendedCountSelected = EXTENDED_GENERATION_COUNTS.includes(count);
  const loadAuthStatus = useCallback(async (signal?: AbortSignal): Promise<AuthStatusResponse | null> => {
    setIsAuthLoading(true);
    setAuthError("");

    try {
      const response = await fetch("/api/auth/status", { signal });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const status = (await response.json()) as AuthStatusResponse;
      setAuthStatus(status);
      return status;
    } catch (error) {
      if (signal?.aborted) {
        return null;
      }

      setAuthError(error instanceof Error ? error.message : "无法读取图像服务登录状态。");
      return null;
    } finally {
      if (!signal?.aborted) {
        setIsAuthLoading(false);
      }
    }
  }, []);

  const panelStatus = useMemo<PanelStatus | null>(() => {
    if (isGenerating) {
      return {
        tone: "progress",
        message: `当前 ${activeGenerationCount} 个任务正在生成到画布，可继续下发新任务。`,
        testId: "generation-progress"
      };
    }

    if (generationError) {
      return {
        tone: "error",
        message: generationError,
        testId: "generation-error"
      };
    }

    if (shouldShowValidation && validationMessage) {
      return {
        tone: "warning",
        message: validationMessage,
        testId: "validation-message"
      };
    }

    if (generationWarning) {
      return {
        tone: "warning",
        message: generationWarning,
        testId: "generation-warning"
      };
    }

    if (generationMessage) {
      return {
        tone: "success",
        message: generationMessage,
        testId: "generation-message"
      };
    }

    return null;
  }, [
    activeGenerationCount,
    generationError,
    generationMessage,
    generationWarning,
    isGenerating,
    shouldShowValidation,
    validationMessage
  ]);

  useEffect(() => {
    const updateRoute = (): void => {
      setRoute(routeFromLocation());
    };

    window.addEventListener("popstate", updateRoute);
    return () => {
      window.removeEventListener("popstate", updateRoute);
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const task of activeGenerationsRef.current.values()) {
        task.controller.abort();
      }
      activeGenerationsRef.current.clear();
      window.clearTimeout(codexPollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadProject(): Promise<void> {
      setSaveStatus("loading");
      setSaveError("");

      try {
        const response = await fetch("/api/project", {
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`Project load failed with ${response.status}`);
        }

        const project = (await response.json()) as ProjectState;
        const snapshot = filterLoadingPlaceholdersFromSnapshot(project.snapshot);
        if (isPersistedSnapshot(snapshot)) {
          setProjectSnapshot(snapshot);
        }
        setGenerationHistory(project.history);
        setSaveStatus("saved");
      } catch {
        if (controller.signal.aborted) {
          return;
        }

        setSaveStatus("error");
        setSaveError("无法载入已保存项目，将使用空白画布。");
      } finally {
        if (!controller.signal.aborted) {
          setIsProjectLoaded(true);
        }
      }
    }

    void loadProject();

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void loadAuthStatus(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadAuthStatus]);

  useEffect(() => {
    if (isAuthLoading || !authStatus || route === "gallery") {
      return;
    }

    if (route === "home" && hasGenerationProvider && shouldAutoOpenCanvasRef.current) {
      shouldAutoOpenCanvasRef.current = false;
      navigateToRoute("canvas", { replace: true });
      return;
    }

    if (route === "canvas" && !hasGenerationProvider) {
      navigateToRoute("home", { replace: true });
    }
  }, [authStatus, hasGenerationProvider, isAuthLoading, navigateToRoute, route]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadStorageConfig(): Promise<void> {
      try {
        const response = await fetch("/api/storage/config", {
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`Storage config load failed with ${response.status}`);
        }

        const config = (await response.json()) as StorageConfigResponse;
        if (controller.signal.aborted) {
          return;
        }

        setStorageConfig(config);
        setStorageForm(storageConfigToForm(config));
        setStorageSecretTouched(false);
      } catch {
        if (!controller.signal.aborted) {
          setStorageError("Unable to load cloud storage settings.");
        }
      }
    }

    void loadStorageConfig();

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_DRAWER_MEDIA_QUERY);
    const updateDrawerMode = (): void => {
      setIsMobileDrawer(mediaQuery.matches);
    };

    updateDrawerMode();
    mediaQuery.addEventListener("change", updateDrawerMode);

    return () => {
      mediaQuery.removeEventListener("change", updateDrawerMode);
    };
  }, []);

  const closeAiPanel = useCallback((): void => {
    setIsAiPanelOpen(false);
    window.requestAnimationFrame(() => {
      canvasShellRef.current?.focus({ preventScroll: true });
    });
  }, []);

  function openStorageDialog(): void {
    setStorageForm(storageConfigToForm(storageConfig));
    setStorageSecretTouched(false);
    setStorageError("");
    setStorageMessage("");
    setIsStorageDialogOpen(true);
  }

  function closeStorageDialog(): void {
    setIsStorageDialogOpen(false);
    setStorageError("");
    setStorageMessage("");
  }

  function closeProviderConfigDialog(): void {
    setIsProviderConfigDialogOpen(false);
  }

  async function startCodexLogin(): Promise<void> {
    window.clearTimeout(codexPollTimerRef.current);
    setIsCodexLoginOpen(true);
    setCodexDevice(null);
    setCodexLoginStatus("starting");
    setCodexLoginMessage("");
    setAuthError("");

    try {
      const response = await fetch("/api/auth/codex/device/start", {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const device = (await response.json()) as CodexDeviceStartResponse;
      setCodexDevice(device);
      setCodexLoginStatus("pending");
      setCodexLoginMessage("等待浏览器授权完成。");
      scheduleCodexPoll(device, device.interval);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex 登录无法启动。";
      setCodexLoginStatus("error");
      setCodexLoginMessage(message);
      setAuthError(message);
    }
  }

  async function pollCodexLogin(device: CodexDeviceStartResponse): Promise<void> {
    try {
      const response = await fetch("/api/auth/codex/device/poll", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          deviceAuthId: device.deviceAuthId,
          userCode: device.userCode
        })
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const result = (await response.json()) as CodexDevicePollResponse;
      if (result.status === "authorized") {
        setCodexLoginStatus("authorized");
        setCodexLoginMessage("Codex 已登录。");
        if (result.auth) {
          setAuthStatus(result.auth);
        } else {
          void loadAuthStatus();
        }
        window.setTimeout(() => {
          setIsCodexLoginOpen(false);
          navigateToRoute("canvas");
        }, 700);
        return;
      }

      if (result.status === "pending") {
        setCodexLoginStatus("pending");
        scheduleCodexPoll(device, result.interval ?? device.interval);
        return;
      }

      setCodexLoginStatus(result.status);
      setCodexLoginMessage(result.message ?? "Codex 登录未完成，请重新开始。");
      void loadAuthStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex 登录轮询失败。";
      setCodexLoginStatus("error");
      setCodexLoginMessage(message);
      setAuthError(message);
    }
  }

  function scheduleCodexPoll(device: CodexDeviceStartResponse, intervalSeconds: number): void {
    window.clearTimeout(codexPollTimerRef.current);
    const delay = Math.max(1, intervalSeconds) * 1000;
    codexPollTimerRef.current = window.setTimeout(() => {
      void pollCodexLogin(device);
    }, delay);
  }

  function closeCodexLoginDialog(): void {
    window.clearTimeout(codexPollTimerRef.current);
    setIsCodexLoginOpen(false);
  }

  async function logoutCodexSession(): Promise<void> {
    window.clearTimeout(codexPollTimerRef.current);
    setIsAuthLoading(true);
    setAuthError("");

    try {
      const response = await fetch("/api/auth/codex/logout", {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const result = (await response.json()) as CodexLogoutResponse;
      setAuthStatus(result.auth);
      setCodexDevice(null);
      setCodexLoginStatus("idle");
      setCodexLoginMessage("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Codex 登出失败。");
    } finally {
      setIsAuthLoading(false);
    }
  }

  async function copyCodexUserCode(): Promise<void> {
    if (!codexDevice) {
      return;
    }

    await writeClipboardText(codexDevice.userCode).catch(() => undefined);
  }

  function updateStorageForm(patch: Partial<StorageConfigFormState>): void {
    setStorageForm((current) => ({
      ...current,
      ...patch
    }));
    setStorageError("");
    setStorageMessage("");
  }

  async function testStorageSettings(): Promise<void> {
    setIsStorageTesting(true);
    setStorageError("");
    setStorageMessage("");

    try {
      const response = await fetch("/api/storage/config/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(
          storageConfigRequestBody(storageForm, {
            preserveSecret: !storageSecretTouched && Boolean(storageConfig?.cos.secretKey.hasSecret),
            forceEnabled: true
          })
        )
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const result = (await response.json()) as StorageTestResult;
      if (!result.ok) {
        setStorageError(result.message);
        return;
      }

      setStorageMessage(result.message);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Cloud storage test failed.");
    } finally {
      setIsStorageTesting(false);
    }
  }

  async function saveStorageSettings(): Promise<void> {
    setIsStorageSaving(true);
    setStorageError("");
    setStorageMessage("");

    try {
      const response = await fetch("/api/storage/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(
          storageConfigRequestBody(storageForm, {
            preserveSecret: !storageSecretTouched && Boolean(storageConfig?.cos.secretKey.hasSecret)
          })
        )
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const config = (await response.json()) as StorageConfigResponse;
      setStorageConfig(config);
      setStorageForm(storageConfigToForm(config));
      setStorageSecretTouched(false);
      setStorageMessage("Cloud storage settings saved.");
      setGenerationMessage(config.enabled ? "Cloud storage is enabled." : "Cloud storage is disabled.");
      setGenerationWarning("");
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Cloud storage settings could not be saved.");
    } finally {
      setIsStorageSaving(false);
    }
  }

  useEffect(() => {
    if (!isMobileDrawer || !isAiPanelOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAiPanel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeAiPanel, isAiPanelOpen, isMobileDrawer]);

  useEffect(() => {
    if (!isMobileDrawer || !isAiPanelOpen) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      panelCloseButtonRef.current?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
    };
  }, [isAiPanelOpen, isMobileDrawer]);

  useEffect(() => {
    generationModeRef.current = generationMode;

    const editor = editorRef.current;
    if (generationMode === "reference" && editor) {
      const nextSelection = resolveReferenceSelection(editor);
      setReferenceSelection((currentSelection) =>
        areReferenceSelectionsEqual(currentSelection, nextSelection) ? currentSelection : nextSelection
      );
      return;
    }

    setReferenceSelection((currentSelection) =>
      areReferenceSelectionsEqual(currentSelection, missingReferenceSelection) ? currentSelection : missingReferenceSelection
    );
  }, [generationMode]);

  const handleEditorMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    if (!editor.user.getIsSnapMode()) {
      editor.user.updateUserPreferences({ isSnapMode: true });
    }

    let referenceSelectionFrame: number | undefined;
    const commitReferenceSelection = (): void => {
      if (generationModeRef.current !== "reference") {
        return;
      }

      const nextSelection = resolveReferenceSelection(editor);
      setReferenceSelection((currentSelection) =>
        areReferenceSelectionsEqual(currentSelection, nextSelection) ? currentSelection : nextSelection
      );
    };
    const updateReferenceSelection = (): void => {
      if (generationModeRef.current !== "reference" || referenceSelectionFrame !== undefined) {
        return;
      }

      referenceSelectionFrame = window.requestAnimationFrame(() => {
        referenceSelectionFrame = undefined;
        commitReferenceSelection();
      });
    };

    async function saveProject(): Promise<void> {
      const requestId = saveRequestRef.current + 1;
      saveRequestRef.current = requestId;
      setSaveStatus("saving");
      setSaveError("");

      try {
        const response = await fetch("/api/project", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            snapshot: filterLoadingPlaceholdersFromSnapshot(editor.getSnapshot())
          })
        });

        if (!response.ok) {
          throw new Error(`Project save failed with ${response.status}`);
        }

        if (saveRequestRef.current === requestId) {
          setSaveStatus("saved");
        }
      } catch {
        if (saveRequestRef.current === requestId) {
          setSaveStatus("error");
          setSaveError("自动保存失败，当前画布已保留，请稍后继续编辑。");
        }
      }
    }

    const removeListener = editor.store.listen(
      () => {
        window.clearTimeout(saveTimerRef.current);
        setSaveStatus((status) => (status === "pending" ? status : "pending"));
        setSaveError((error) => (error ? "" : error));
        saveTimerRef.current = window.setTimeout(() => {
          void saveProject();
        }, AUTOSAVE_DEBOUNCE_MS);
      },
      {
        source: "user",
        scope: "document"
      }
    );
    const removeReferenceStoreListener = editor.store.listen(updateReferenceSelection, {
      source: "all",
      scope: "all"
    });
    editor.on("change", updateReferenceSelection);
    commitReferenceSelection();

    return () => {
      window.clearTimeout(saveTimerRef.current);
      if (referenceSelectionFrame !== undefined) {
        window.cancelAnimationFrame(referenceSelectionFrame);
      }
      if (editorRef.current === editor) {
        editorRef.current = null;
      }
      editor.off("change", updateReferenceSelection);
      removeReferenceStoreListener();
      removeListener();
    };
  }, []);

  function selectScenePreset(nextPresetId: string): void {
    if (nextPresetId === CUSTOM_SIZE_PRESET_ID) {
      setSizePresetId(CUSTOM_SIZE_PRESET_ID);
      return;
    }

    const preset = SIZE_PRESETS.find((item) => item.id === nextPresetId);
    if (!preset) {
      return;
    }

    setSizePresetId(preset.id);
    setWidth(preset.width);
    setHeight(preset.height);
  }

  function updateWidth(value: string): void {
    setWidth(normalizeDimension(value));
    setSizePresetId(CUSTOM_SIZE_PRESET_ID);
  }

  function updateHeight(value: string): void {
    setHeight(normalizeDimension(value));
    setSizePresetId(CUSTOM_SIZE_PRESET_ID);
  }

  function applyPromptStarter(starter: string): void {
    setPrompt(starter);
    setGenerationError("");
    setGenerationMessage("");
    setGenerationWarning("");
  }

  async function executeGeneration(
    input: GenerationSubmitInput,
    requestMode: GenerationMode,
    resolveReference?: (signal: AbortSignal) => Promise<GenerationReferenceInput | undefined>,
    referenceAssetIds?: string[]
  ): Promise<void> {
    setGenerationError("");
    setGenerationMessage("");
    setGenerationWarning("");

    const inputValidationMessage = generationValidationMessage(input.prompt, input.size.width, input.size.height);
    if (inputValidationMessage) {
      setGenerationWarning(inputValidationMessage);
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      setGenerationError("画布未就绪。");
      return;
    }

    requestGenerationNotificationPermission();

    const controller = new AbortController();
    const requestId = generationRequestRef.current + 1;
    generationRequestRef.current = requestId;
    const placeholderSet = createGenerationPlaceholders(editor, input, requestId, {
      selectPlaceholders: requestMode !== "reference"
    });
    const temporaryRecord = createTemporaryGenerationRecord({
      requestId,
      submitInput: input,
      requestMode,
      referenceAssetIds
    });

    activeGenerationsRef.current.set(requestId, {
      requestId,
      temporaryRecordId: temporaryRecord.id,
      controller,
      placeholderSet
    });
    setActiveGenerationCount(activeGenerationsRef.current.size);
    setGenerationHistory((history) => [temporaryRecord, ...history.filter((record) => record.id !== temporaryRecord.id)].slice(0, 20));

    try {
      const referenceForRequest = requestMode === "reference" ? await resolveReference?.(controller.signal) : undefined;
      if (requestMode === "reference" && (!referenceForRequest || referenceForRequest.referenceImages.length === 0)) {
        throw new Error(`请先选择 1-${MAX_REFERENCE_IMAGES} 张可用的参考图像。`);
      }

      const requestBody: Record<string, unknown> = {
        prompt: input.prompt.trim(),
        presetId: input.presetId,
        sizePresetId: input.sizePresetId,
        size: input.size,
        quality: input.quality,
        outputFormat: input.outputFormat,
        count: input.count
      };

      if (requestMode === "reference" && referenceForRequest) {
        requestBody.referenceImages = referenceForRequest.referenceImages;
        if (referenceForRequest.referenceAssetIds?.length) {
          requestBody.referenceAssetIds = referenceForRequest.referenceAssetIds;
        }
      }

      const response = await fetch(requestMode === "reference" ? "/api/images/edit" : "/api/images/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const body = (await response.json()) as unknown;
      if (!isGenerationResponse(body)) {
        throw new Error("生成服务返回了无法识别的结果。");
      }

      if (controller.signal.aborted || !activeGenerationsRef.current.has(requestId)) {
        return;
      }

      await preloadGenerationRecordPreviews(body.record, controller.signal);
      if (controller.signal.aborted || !activeGenerationsRef.current.has(requestId)) {
        return;
      }

      setGenerationHistory((history) =>
        [body.record, ...history.filter((record) => record.id !== temporaryRecord.id && record.id !== body.record.id)].slice(0, 20)
      );
      const insertedCount = replaceGenerationPlaceholders(editor, placeholderSet, body.record);
      const failedCount =
        body.record.outputs.filter((output) => output.status === "failed").length +
        Math.max(0, placeholderSet.placements.length - body.record.outputs.length);
      const cloudFailedCount = cloudFailureCount(body.record);
      if (insertedCount > 0) {
        if (cloudFailedCount > 0 || failedCount > 0) {
          setGenerationWarning(generationWarningMessage(body.record, insertedCount, failedCount, cloudFailedCount));
        } else {
          setGenerationMessage(`已向画布插入 ${insertedCount} 张图像。`);
        }
        showGenerationCompleteNotification(body.record, insertedCount, failedCount);
      } else {
        setGenerationError(generationFailureMessage(body.record));
      }
    } catch (error) {
      if (controller.signal.aborted || !activeGenerationsRef.current.has(requestId)) {
        return;
      }

      const message = error instanceof Error ? error.message : "生成失败，请重试。";
      markGenerationPlaceholdersFailed(editor, placeholderSet, message);
      setGenerationHistory((history) =>
        history.map((record) => (record.id === temporaryRecord.id ? { ...record, status: "failed", error: message } : record))
      );
      setGenerationError(message);
    } finally {
      if (activeGenerationsRef.current.delete(requestId)) {
        setActiveGenerationCount(activeGenerationsRef.current.size);
      }
    }
  }

  async function submitGeneration(): Promise<void> {
    const input: GenerationSubmitInput = {
      prompt: trimmedPrompt,
      presetId: stylePreset,
      sizePresetId,
      size: {
        width,
        height
      },
      quality,
      outputFormat,
      count
    };

    if (generationMode === "reference") {
      await executeGeneration(input, "reference", async (signal) => {
        if (referenceSelection.status !== "ready") {
          return undefined;
        }

        const referenceAssetIds = referenceAssetIdsForSelection(referenceSelection);

        return {
          referenceImages: await Promise.all(referenceSelection.references.map((reference) => readReferenceImage(reference, signal))),
          referenceAssetIds
        };
      }, referenceSelection.status === "ready"
        ? referenceAssetIdsForSelection(referenceSelection)
        : undefined);
      return;
    }

    await executeGeneration(input, "text");
  }

  function cancelReferenceSelection(): void {
    editorRef.current?.selectNone();
    setReferenceSelection(missingReferenceSelection);
    setGenerationError("");
    setGenerationMessage("");
    setGenerationWarning("");
  }

  function locateHistoryRecord(record: GenerationRecord): void {
    setGenerationError("");
    setGenerationMessage("");
    setGenerationWarning("");

    const editor = editorRef.current;
    if (!editor) {
      setGenerationError("画布未就绪。");
      return;
    }

    const shapeId = findCanvasImageShape(editor, record);
    if (!shapeId) {
      const activeTask = Array.from(activeGenerationsRef.current.values()).find((task) => task.temporaryRecordId === record.id);
      const placeholderId = activeTask ? firstLiveGenerationPlaceholder(editor, activeTask.placeholderSet) : undefined;
      if (!placeholderId) {
        setGenerationError("画布上找不到这张历史图片，可能已被删除。");
        return;
      }

      const bounds = editor.getShapePageBounds(placeholderId);
      editor.select(placeholderId);
      if (bounds) {
        editor.zoomToBounds(bounds, {
          animation: { duration: 220 },
          inset: 96
        });
      } else {
        editor.zoomToSelection({ animation: { duration: 220 } });
      }
      setGenerationMessage("已定位到生成中的任务。");
      return;
    }

    const bounds = editor.getShapePageBounds(shapeId);
    editor.select(shapeId);
    if (bounds) {
      editor.zoomToBounds(bounds, {
        animation: { duration: 220 },
        inset: 96
      });
    } else {
      editor.zoomToSelection({ animation: { duration: 220 } });
    }
    setGenerationMessage("已定位到历史图像。");
  }

  async function rerunHistoryRecord(record: GenerationRecord): Promise<void> {
    const nextPresetId = coerceStylePresetId(record.presetId);
    const nextSizePresetId = sizePresetIdForSize(record.size.width, record.size.height);
    const nextCount = coerceGenerationCount(record.count);

    setPrompt(record.prompt);
    setStylePreset(nextPresetId);
    setSizePresetId(nextSizePresetId);
    setWidth(record.size.width);
    setHeight(record.size.height);
    setQuality(record.quality);
    setOutputFormat(record.outputFormat);
    setCount(nextCount);

    const referenceAssetIds = referenceAssetIdsForRecord(record);
    const nextGenerationMode: GenerationMode = referenceAssetIds.length > 0 ? "reference" : "text";
    setGenerationMode(nextGenerationMode);

    await executeGeneration(
      {
        prompt: record.prompt,
        presetId: nextPresetId,
        sizePresetId: nextSizePresetId,
        size: record.size,
        quality: record.quality,
        outputFormat: record.outputFormat,
        count: nextCount
      },
      nextGenerationMode,
      referenceAssetIds.length > 0
        ? async (signal) => ({
            referenceImages: await Promise.all(referenceAssetIds.map((referenceAssetId) => readStoredReferenceImage(referenceAssetId, signal))),
            referenceAssetIds
          })
        : undefined,
      referenceAssetIds.length > 0 ? referenceAssetIds : undefined
    );
  }

  function downloadHistoryRecord(record: GenerationRecord): void {
    const asset = firstDownloadableAsset(record);
    setGenerationWarning("");
    if (!asset) {
      setGenerationError("这条历史记录没有可下载的本地资源。");
      return;
    }

    window.open(`/api/assets/${encodeURIComponent(asset.id)}/download`, "_blank", "noopener,noreferrer");
    setGenerationMessage("已打开原始资源下载。");
  }

  function reuseGalleryImage(item: GalleryImageItem): void {
    const nextPresetId = coerceStylePresetId(item.presetId);
    const nextSizePresetId = sizePresetIdForSize(item.size.width, item.size.height);

    setPrompt(item.prompt);
    setStylePreset(nextPresetId);
    setSizePresetId(nextSizePresetId);
    setWidth(item.size.width);
    setHeight(item.size.height);
    setQuality(item.quality);
    setOutputFormat(item.outputFormat);
    setCount(1);
    setGenerationMode("text");
    setGenerationError("");
    setGenerationWarning("");
    setGenerationMessage("已从 Gallery 填入生成参数。");
    navigateToRoute("canvas");
    if (isMobileDrawer) {
      setIsAiPanelOpen(true);
    }
  }

  function removeGalleryOutputFromHistory(outputId: string): void {
    setGenerationHistory((history) =>
      history.flatMap((record) => {
        const nextOutputs = record.outputs.filter((output) => output.id !== outputId);
        if (nextOutputs.length === record.outputs.length) {
          return [record];
        }
        if (nextOutputs.length === 0) {
          return [];
        }
        return [
          {
            ...record,
            outputs: nextOutputs
          }
        ];
      })
    );
  }

  async function copyHistoryPrompt(record: GenerationRecord): Promise<void> {
    const promptText = record.prompt.trim();
    setGenerationError("");
    setGenerationMessage("");
    setGenerationWarning("");

    if (!promptText) {
      setGenerationError("这条历史记录没有可复制的提示词。");
      return;
    }

    try {
      await writeClipboardText(promptText);
      setGenerationMessage("已复制提示词。");
    } catch {
      setGenerationError("复制失败，请手动复制提示词。");
    }
  }

  function cancelGeneration(requestId: number): void {
    const task = activeGenerationsRef.current.get(requestId);
    if (!task) {
      return;
    }

    task.controller.abort();
    const editor = editorRef.current;
    if (editor) {
      deleteLoadingGenerationPlaceholders(editor, task.placeholderSet);
    }

    activeGenerationsRef.current.delete(requestId);
    setActiveGenerationCount(activeGenerationsRef.current.size);
    setGenerationHistory((history) =>
      history.map((record) =>
        record.id === task.temporaryRecordId ? { ...record, status: "cancelled", error: "已取消本次生成。" } : record
      )
    );
    setGenerationError("");
    setGenerationMessage("已取消本次生成。");
    setGenerationWarning("");
  }

  return (
    <div className="app-root" data-canvas-theme={route !== "home" && isCanvasDarkMode ? "dark" : "light"}>
      <TopNavigation
        route={route}
        onNavigate={navigateToRoute}
        onOpenProviderConfig={() => setIsProviderConfigDialogOpen(true)}
        onPreloadGallery={preloadGalleryPage}
      />
      {route === "home" ? (
        <HomePage
          authError={authError}
          authStatus={authStatus}
          isAuthLoading={isAuthLoading}
          isCodexStarting={codexLoginStatus === "starting"}
          onOpenProviderConfig={() => setIsProviderConfigDialogOpen(true)}
          onOpenGallery={() => navigateToRoute("gallery")}
          onStartCodexLogin={startCodexLogin}
        />
      ) : null}
      <main className="app-shell app-view relative flex min-h-0 overflow-hidden bg-neutral-950 text-neutral-900" data-active-route={route} hidden={route !== "canvas"}>
      <section
        className="relative min-w-0 flex-1 bg-neutral-100 outline-none"
        aria-label="gpt-image-canvas 创作画布"
        data-testid="canvas-shell"
        ref={canvasShellRef}
        tabIndex={-1}
      >
        {isProjectLoaded ? (
          <Tldraw
            assets={canvasAssetStore}
            components={tldrawComponents}
            licenseKey={TLDRAW_LICENSE_KEY}
            options={tldrawOptions}
            snapshot={projectSnapshot}
            shapeUtils={shapeUtils}
            onMount={handleEditorMount}
          />
        ) : (
          <div className="canvas-loading-state">
            <BrandMark className="brand-mark--large" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-neutral-800">正在载入 gpt-image-canvas</p>
              <p className="mt-1 text-xs text-neutral-500">本地 AI 图像画布</p>
            </div>
          </div>
        )}
      </section>

      {isMobileDrawer && isAiPanelOpen ? (
        <button
          aria-label="关闭生成到画布面板"
          className="ai-panel-backdrop"
          data-testid="ai-panel-backdrop"
          type="button"
          onClick={closeAiPanel}
        />
      ) : null}

      <button
        aria-controls="ai-panel"
        aria-expanded={isAiPanelOpen}
        aria-haspopup="dialog"
        className="mobile-ai-trigger"
        data-drawer-state={isAiPanelOpen ? "open" : "closed"}
        data-testid="open-ai-panel"
        type="button"
        onClick={() => setIsAiPanelOpen(true)}
      >
        <Sparkles className="size-4" aria-hidden="true" />
        生成到画布
      </button>

      <aside
        aria-hidden={isMobileDrawer && !isAiPanelOpen ? true : undefined}
        aria-label="AI 生成面板"
        aria-modal={isMobileDrawer && isAiPanelOpen ? true : undefined}
        className="ai-panel fixed inset-y-0 right-0 z-20 flex flex-col border-l border-neutral-200 bg-white shadow-2xl shadow-neutral-950/15"
        data-drawer-state={isAiPanelOpen ? "open" : "closed"}
        data-testid="ai-panel"
        id="ai-panel"
        role={isMobileDrawer ? "dialog" : "complementary"}
        {...(isMobileDrawer && !isAiPanelOpen ? { inert: "" } : {})}
      >
        <div className="border-b border-neutral-200 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="brand-lockup">
              <BrandMark />
              <div className="min-w-0">
                <BrandName />
                <p className="brand-tagline">本地 AI 图像画布</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ProviderStatusPopover
                authError={authError}
                authStatus={authStatus}
                codexLoginStatus={codexLoginStatus}
                isAuthLoading={isAuthLoading}
                onLogoutCodex={logoutCodexSession}
                onStartCodexLogin={startCodexLogin}
              />
              <button
                aria-label="云存储设置"
                className={`inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs transition focus:outline-none focus:ring-2 focus:ring-cyan-100 ${
                  storageConfig?.enabled
                    ? "border-cyan-200 bg-cyan-50 text-cyan-700 hover:bg-cyan-100"
                    : "border-neutral-200 bg-white text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900"
                }`}
                data-testid="storage-settings-button"
                title={storageConfig?.enabled ? "云存储已开启" : "云存储设置"}
                type="button"
                onClick={openStorageDialog}
              >
                <Cloud className="size-4" aria-hidden="true" />
              </button>
              <div
                className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${
                  saveStatus === "error" ? "bg-red-50 text-red-700" : "bg-neutral-100 text-neutral-600"
                }`}
                data-testid="save-status"
                role="status"
              >
                <SaveStatusIcon status={saveStatus} />
                {saveStatusLabel(saveStatus)}
              </div>
              <button
                aria-label="关闭生成到画布面板"
                className="ai-panel-close"
                ref={panelCloseButtonRef}
                type="button"
                onClick={closeAiPanel}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <div className="ai-panel-body flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {saveError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="save-error">
              {saveError}
            </p>
          ) : null}

          <div data-testid="generation-mode-control">
            <span className="control-label">模式</span>
            <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="模式">
              <button
                className={generationMode === "text" ? "segmented-control h-9 text-xs is-active" : "segmented-control h-9 text-xs"}
                type="button"
                aria-pressed={generationMode === "text"}
                data-testid="mode-text"
                onClick={() => setGenerationMode("text")}
              >
                提示词到画布
              </button>
              <button
                className={
                  generationMode === "reference" ? "segmented-control h-9 text-xs is-active" : "segmented-control h-9 text-xs"
                }
                type="button"
                aria-pressed={generationMode === "reference"}
                data-testid="mode-reference"
                onClick={() => setGenerationMode("reference")}
              >
                参考图到画布
              </button>
            </div>
          </div>

          <label className="block">
            <span className="control-label">提示词</span>
            <textarea
              aria-invalid={Boolean(promptValidationMessage)}
              className="prompt-textarea mt-2 h-32 w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm leading-6 text-neutral-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              id="prompt-input"
              name="prompt"
              placeholder="描述画面主体、场景、光线、构图和关键细节"
              value={prompt}
              data-testid="prompt-input"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          {!trimmedPrompt ? (
            <div className="-mt-3 flex flex-wrap gap-2" data-testid="prompt-starters">
              {promptStarters.map((starter) => (
                <button
                  className="prompt-chip"
                  key={starter.label}
                  type="button"
                  title={starter.prompt}
                  data-testid="prompt-starter-chip"
                  onClick={() => applyPromptStarter(starter.prompt)}
                >
                  {starter.label}
                </button>
              ))}
            </div>
          ) : null}

          {isReferenceMode ? (
            <section
              className={`rounded-md border px-3 py-3 ${
                isReferenceReady ? "border-blue-200 bg-blue-50 text-blue-800" : "border-neutral-200 bg-neutral-50 text-neutral-600"
              }`}
              data-reference-state={referenceSelection.status}
              data-testid="reference-state"
            >
              <div className="flex items-start gap-2">
                <ImageIcon className={`mt-0.5 size-4 ${isReferenceReady ? "text-blue-600" : "text-neutral-400"}`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {referenceSelection.status === "ready"
                      ? `${referenceSelection.references.length} 张参考图到画布已就绪`
                      : `请选择 1-${MAX_REFERENCE_IMAGES} 张参考图`}
                  </p>
                  <p className="mt-1 text-xs leading-5" data-testid="reference-hint">
                    {referenceSelection.hint}
                  </p>
                  {referenceSelection.status === "ready" ? (
                    <div className="reference-preview-list">
                      {referenceSelection.references.map((reference, index) => (
                        <div className="reference-preview-card" key={`${reference.sourceUrl}-${index}`}>
                          <span className="reference-preview-card__index">{index + 1}</span>
                          <img
                            alt={`参考图 ${index + 1}：${reference.name}`}
                            className="reference-preview-card__image"
                            src={reference.sourceUrl}
                          />
                          <p className="min-w-0 flex-1 truncate text-xs font-medium" data-testid="reference-name">
                            {reference.name}
                            <span>{Math.round(reference.width)} x {Math.round(reference.height)}</span>
                          </p>
                        </div>
                      ))}
                      <button
                        className="secondary-action h-8 shrink-0 px-2 text-xs"
                        type="button"
                        data-testid="cancel-reference"
                        onClick={cancelReferenceSelection}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                        取消参考
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          <label className="block">
            <span className="control-label">风格</span>
            <select
              className="field-control"
              id="style-preset"
              name="stylePreset"
              value={stylePreset}
              data-testid="style-preset"
              onChange={(event) => setStylePreset(event.target.value as StylePresetId)}
            >
              {STYLE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {stylePresetLabels[preset.id]}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className="control-label">尺寸</span>
            <div className="quick-size-grid" data-testid="quick-size-presets">
              {quickSizePresets.map((preset) => (
                <button
                  aria-pressed={sizePresetId === preset.id}
                  className={sizePresetId === preset.id ? "quick-size-button is-active" : "quick-size-button"}
                  key={preset.id}
                  type="button"
                  onClick={() => selectScenePreset(preset.id)}
                >
                  <span>{sizePresetLabel(preset)}</span>
                  <small>
                    {preset.width} x {preset.height}
                  </small>
                </button>
              ))}
              <button
                aria-pressed={sizePresetId === CUSTOM_SIZE_PRESET_ID}
                className={sizePresetId === CUSTOM_SIZE_PRESET_ID ? "quick-size-button is-active" : "quick-size-button"}
                type="button"
                onClick={() => selectScenePreset(CUSTOM_SIZE_PRESET_ID)}
              >
                <span>自定义</span>
                <small>手动输入</small>
              </button>
            </div>
            <label className="mt-3 block">
              <span className="sr-only">全部尺寸</span>
              <select
                className="field-control"
                id="scene-preset"
                name="scenePreset"
                value={sizePresetId}
                data-testid="scene-preset"
                onChange={(event) => selectScenePreset(event.target.value)}
              >
                {SIZE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {sizePresetOptionLabel(preset)}
                  </option>
                ))}
                <option value={CUSTOM_SIZE_PRESET_ID}>自定义尺寸</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="control-label">宽度</span>
              <input
                className="field-control"
                id="custom-width"
                min={MIN_IMAGE_DIMENSION}
                max={MAX_IMAGE_DIMENSION}
                name="width"
                step={1}
                type="number"
                value={Number.isNaN(width) ? "" : width}
                data-testid="custom-width"
                onChange={(event) => updateWidth(event.target.value)}
              />
            </label>
            <label>
              <span className="control-label">高度</span>
              <input
                className="field-control"
                id="custom-height"
                min={MIN_IMAGE_DIMENSION}
                max={MAX_IMAGE_DIMENSION}
                name="height"
                step={1}
                type="number"
                value={Number.isNaN(height) ? "" : height}
                data-testid="custom-height"
                onChange={(event) => updateHeight(event.target.value)}
              />
            </label>
          </div>

          <div>
            <span className="control-label">数量</span>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {PRIMARY_GENERATION_COUNTS.map((item) => (
                <button
                  className={item === count ? "segmented-control is-active" : "segmented-control"}
                  key={item}
                  type="button"
                  onClick={() => setCount(item)}
                >
                  {item}
                </button>
              ))}
            </div>

            <details className="group mt-2 rounded-md border border-neutral-200 bg-neutral-50">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-neutral-800">
                <span>{isExtendedCountSelected ? `更多数量：${count} 张` : "更多数量"}</span>
                <ChevronDown className="size-4 shrink-0 text-neutral-500 transition group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div className="grid grid-cols-2 gap-2 border-t border-neutral-200 px-3 py-3">
                {EXTENDED_GENERATION_COUNTS.map((item) => (
                  <button
                    className={item === count ? "segmented-control is-active" : "segmented-control"}
                    key={item}
                    type="button"
                    onClick={() => setCount(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </details>
          </div>

          <details className="rounded-md border border-neutral-200 bg-neutral-50">
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-3 text-sm font-medium text-neutral-800">
              高级设置
              <ChevronDown className="size-4 text-neutral-500" aria-hidden="true" />
            </summary>
            <div className="space-y-4 border-t border-neutral-200 px-3 py-4">
              <label className="block">
                <span className="control-label">质量</span>
                <select
                  className="field-control"
                  id="quality-select"
                  name="quality"
                  value={quality}
                  data-testid="quality-select"
                  onChange={(event) => setQuality(event.target.value as ImageQuality)}
                >
                  {IMAGE_QUALITIES.map((item) => (
                    <option key={item} value={item}>
                      {qualityLabels[item]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="control-label">输出格式</span>
                <select
                  className="field-control"
                  id="format-select"
                  name="outputFormat"
                  value={outputFormat}
                  data-testid="format-select"
                  onChange={(event) => setOutputFormat(event.target.value as OutputFormat)}
                >
                  {OUTPUT_FORMATS.map((item) => (
                    <option key={item} value={item}>
                      {formatLabels[item]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </details>

          <section className="space-y-3" data-history-expanded={isHistoryExpanded} data-testid="generation-history">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-neutral-950">生成历史</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-500">{generationHistory.length} 条</span>
                {hasAdditionalHistory ? (
                  <button
                    aria-expanded={isHistoryExpanded}
                    className="history-toggle"
                    data-testid="history-toggle"
                    type="button"
                    onClick={() => setIsHistoryExpanded((expanded) => !expanded)}
                  >
                    {isHistoryExpanded ? "收起" : `展开 ${hiddenHistoryCount} 条`}
                    <ChevronDown className={`size-3.5 transition ${isHistoryExpanded ? "rotate-180" : ""}`} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>

            {generationHistory.length === 0 ? (
              <p className="rounded-md border border-dashed border-neutral-300 px-3 py-4 text-sm text-neutral-500">
                暂无记录。
              </p>
            ) : (
              <div className="history-list">
                {visibleHistory.map((record) => {
                  const downloadableAsset = firstDownloadableAsset(record);
                  const excerpt = promptExcerpt(record.prompt);
                  const totalOutputs = record.outputs.length || record.count;
                  const activeTask = Array.from(activeGenerationsRef.current.values()).find((task) => task.temporaryRecordId === record.id);
                  const isRecordRunning = record.status === "running" && Boolean(activeTask);
                  const cloudFailedCount = cloudFailureCount(record);
                  const cloudFailureMessage = firstCloudFailureMessage(record);

                  return (
                    <article
                      className="history-item"
                      data-testid="history-record"
                      key={record.id}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`history-status-pill ${historyStatusStyles[record.status]}`}>
                            {statusLabels[record.status]}
                          </span>
                          <span className="truncate text-xs text-neutral-500">{modeLabels[record.mode]}</span>
                        </div>
                        <p className="mt-1 truncate text-sm font-medium leading-5 text-neutral-950" title={record.prompt}>
                          {excerpt}
                        </p>
                        <dl className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs leading-5 text-neutral-500">
                          <div className="inline-flex items-center gap-1">
                            <dt className="sr-only">尺寸</dt>
                            <dd>
                              {record.size.width} x {record.size.height}
                            </dd>
                          </div>
                          <div className="inline-flex items-center gap-1">
                            <dt className="sr-only">输出数量</dt>
                            <dd>
                              {successfulOutputCount(record)} / {totalOutputs} 张
                            </dd>
                          </div>
                          <div className="inline-flex items-center gap-1">
                            <dt className="sr-only">创建时间</dt>
                            <dd>{formatCreatedTime(record.createdAt)}</dd>
                          </div>
                          {cloudFailedCount > 0 ? (
                            <div className="inline-flex items-center gap-1 text-amber-700" title={cloudFailureMessage}>
                              <dt className="sr-only">云端备份</dt>
                              <dd className="inline-flex items-center gap-1">
                                <Cloud className="size-3" aria-hidden="true" />
                                云端失败 {cloudFailedCount}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      </div>

                      <div className="history-actions">
                        <button
                          aria-label={`复制历史提示词：${excerpt}`}
                          className="history-icon-action"
                          type="button"
                          data-testid="history-copy-prompt"
                          title="复制提示词"
                          onClick={() => void copyHistoryPrompt(record)}
                        >
                          <Copy className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          aria-label={`定位历史记录：${excerpt}`}
                          className="history-icon-action"
                          type="button"
                          data-testid="history-locate"
                          title="定位"
                          onClick={() => locateHistoryRecord(record)}
                        >
                          <MapPin className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          aria-label={`重跑历史记录：${excerpt}`}
                          className="history-icon-action"
                          type="button"
                          data-testid="history-rerun"
                          disabled={isRecordRunning}
                          title={isRecordRunning ? "任务运行中" : "重跑"}
                          onClick={() => void rerunHistoryRecord(record)}
                        >
                          <RotateCcw className="size-4" aria-hidden="true" />
                        </button>
                        {activeTask && record.status === "running" ? (
                          <button
                            aria-label={`取消生成任务：${excerpt}`}
                            className="history-icon-action"
                            type="button"
                            data-testid="history-cancel"
                            title="取消"
                            onClick={() => cancelGeneration(activeTask.requestId)}
                          >
                            <XCircle className="size-4" aria-hidden="true" />
                          </button>
                        ) : (
                          <button
                            aria-label={`下载历史记录：${excerpt}`}
                            className="history-icon-action"
                            type="button"
                            data-testid="history-download"
                            disabled={!downloadableAsset}
                            title={downloadableAsset ? "下载" : "没有可下载的本地资源"}
                            onClick={() => downloadHistoryRecord(record)}
                          >
                            <Download className="size-4" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <div className="ai-panel-actions grid grid-cols-1 gap-3 border-t border-neutral-200 bg-white px-5 py-4">
          {panelStatus ? (
            <div
              aria-live={panelStatus.tone === "progress" ? "polite" : "assertive"}
              className={`action-feedback panel-status-strip panel-status--${panelStatus.tone}`}
              data-testid={`action-${panelStatus.testId}`}
              role={panelStatus.tone === "success" || panelStatus.tone === "progress" ? "status" : "alert"}
            >
              {panelStatus.message}
            </div>
          ) : null}
          <button
            className="primary-action"
            disabled={!canGenerate}
            type="button"
            data-generation-mode={generationMode}
            data-reference-mode={isReferenceReady ? "edit" : "generate"}
            data-testid="generate-button"
            title={validationMessage || undefined}
            onClick={submitGeneration}
          >
            {isReferenceReady ? (
              <ImageIcon className="size-4" aria-hidden="true" />
            ) : (
              <Square className="size-4" aria-hidden="true" />
            )}
            {generationMode === "reference" ? "参考图生成到画布" : "生成到画布"}
          </button>
        </div>
      </aside>

      {isStorageDialogOpen ? (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-neutral-950/45 px-4 py-6" data-testid="storage-dialog">
          <div
            aria-labelledby="storage-dialog-title"
            aria-modal="true"
            className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-2xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-neutral-950" id="storage-dialog-title">
                  云存储设置
                </h2>
                <p className="mt-1 text-xs leading-5 text-neutral-500">腾讯云 COS，生成图本地保存后同步上传。</p>
              </div>
              <button
                aria-label="关闭云存储设置"
                className="history-icon-action"
                type="button"
                onClick={closeStorageDialog}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto px-5 py-5">
              {storageError ? (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700" role="alert">
                  {storageError}
                </p>
              ) : null}
              {storageMessage ? (
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-5 text-emerald-700" role="status">
                  {storageMessage}
                </p>
              ) : null}

              <label className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-3">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-neutral-900">启用 COS 双写</span>
                  <span className="mt-0.5 block text-xs leading-5 text-neutral-500">关闭后新图只写本地，已有云端对象保留。</span>
                </span>
                <input
                  checked={storageForm.enabled}
                  className="size-4 accent-blue-600"
                  data-testid="storage-enabled"
                  id="storage-enabled"
                  name="storageEnabled"
                  type="checkbox"
                  onChange={(event) => updateStorageForm({ enabled: event.target.checked })}
                />
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="block sm:col-span-2">
                  <span className="control-label">SecretId</span>
                  <input
                    className="field-control"
                    data-testid="storage-secret-id"
                    id="storage-secret-id"
                    name="storageSecretId"
                    value={storageForm.secretId}
                    onChange={(event) => updateStorageForm({ secretId: event.target.value })}
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="control-label">SecretKey</span>
                  <input
                    className="field-control"
                    data-testid="storage-secret-key"
                    id="storage-secret-key"
                    name="storageSecretKey"
                    type={storageSecretTouched ? "password" : "text"}
                    value={storageForm.secretKey}
                    onChange={(event) => {
                      setStorageSecretTouched(true);
                      updateStorageForm({ secretKey: event.target.value });
                    }}
                  />
                </label>
                <label className="block">
                  <span className="control-label">Bucket</span>
                  <input
                    className="field-control"
                    data-testid="storage-bucket"
                    id="storage-bucket"
                    name="storageBucket"
                    value={storageForm.bucket}
                    onChange={(event) => updateStorageForm({ bucket: event.target.value })}
                  />
                </label>
                <label className="block">
                  <span className="control-label">Region</span>
                  <input
                    className="field-control"
                    data-testid="storage-region"
                    id="storage-region"
                    name="storageRegion"
                    value={storageForm.region}
                    onChange={(event) => updateStorageForm({ region: event.target.value })}
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="control-label">Key Prefix</span>
                  <input
                    className="field-control"
                    data-testid="storage-prefix"
                    id="storage-prefix"
                    name="storagePrefix"
                    value={storageForm.keyPrefix}
                    onChange={(event) => updateStorageForm({ keyPrefix: event.target.value })}
                  />
                </label>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-neutral-200 px-5 py-4">
              <button
                className="secondary-action h-10"
                data-testid="storage-test"
                disabled={isStorageTesting || isStorageSaving}
                type="button"
                onClick={() => void testStorageSettings()}
              >
                {isStorageTesting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Cloud className="size-4" aria-hidden="true" />}
                测试
              </button>
              <button
                className="primary-action h-10"
                data-testid="storage-save"
                disabled={isStorageSaving || isStorageTesting}
                type="button"
                onClick={() => void saveStorageSettings()}
              >
                {isStorageSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="size-4" aria-hidden="true" />}
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isCodexLoginOpen ? createPortal(
        (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-neutral-950/45 px-4 py-6" data-testid="codex-login-dialog">
          <div
            aria-labelledby="codex-login-title"
            aria-modal="true"
            className="codex-login-dialog"
            role="dialog"
          >
            <div className="codex-login-dialog__header">
              <div className="min-w-0">
                <h2 id="codex-login-title">登录 Codex</h2>
                <p>使用 Codex 账号授权本地生成服务。</p>
              </div>
              <button
                aria-label="关闭 Codex 登录"
                className="history-icon-action"
                type="button"
                onClick={closeCodexLoginDialog}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>

            <div className="codex-login-dialog__body">
              {codexLoginStatus === "starting" ? (
                <div className="codex-login-dialog__status" role="status">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  正在创建登录码...
                </div>
              ) : null}

              {codexDevice ? (
                <>
                  <div className="codex-device-code" data-testid="codex-user-code">
                    {codexDevice.userCode}
                  </div>
                  <div className="codex-login-dialog__actions">
                    <a className="primary-action h-10" href={codexDevice.verificationUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-4" aria-hidden="true" />
                      打开登录页
                    </a>
                    <button className="secondary-action h-10" type="button" onClick={() => void copyCodexUserCode()}>
                      <Copy className="size-4" aria-hidden="true" />
                      复制代码
                    </button>
                  </div>
                  <p className="codex-login-dialog__hint">
                    代码将在 {formatCodexExpiry(codexDevice.expiresAt)} 过期。
                  </p>
                </>
              ) : null}

              {codexLoginMessage ? (
                <p
                  className={`codex-login-dialog__message codex-login-dialog__message--${codexLoginStatus}`}
                  data-testid="codex-login-message"
                  role={codexLoginStatus === "pending" || codexLoginStatus === "authorized" ? "status" : "alert"}
                >
                  {codexLoginStatus === "pending" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                  {codexLoginMessage}
                </p>
              ) : null}

              {codexLoginStatus === "expired" || codexLoginStatus === "denied" || codexLoginStatus === "error" ? (
                <button className="secondary-action h-10" type="button" onClick={() => void startCodexLogin()}>
                  <KeyRound className="size-4" aria-hidden="true" />
                  重新开始
                </button>
              ) : null}
            </div>
          </div>
        </div>
        ),
        document.body
      ) : null}
      </main>
      {isProviderConfigDialogOpen ? (
        <ProviderConfigDialog
          isAuthLoading={isAuthLoading}
          isCodexStarting={codexLoginStatus === "starting"}
          onClose={closeProviderConfigDialog}
          onLogoutCodex={logoutCodexSession}
          onRefreshAuthStatus={loadAuthStatus}
          onStartCodexLogin={startCodexLogin}
        />
      ) : null}
      {route === "gallery" ? (
        <Suspense
          fallback={
            <main className="gallery-page app-view" data-testid="gallery-loading-page">
              <div className="gallery-empty-state gallery-empty-state--boot" role="status">
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                <p>正在载入 Gallery...</p>
              </div>
            </main>
          }
        >
          <LazyGalleryPage onDeleted={removeGalleryOutputFromHistory} onReuse={reuseGalleryImage} />
        </Suspense>
      ) : null}
    </div>
  );
}
