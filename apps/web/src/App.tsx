import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Copy,
  Download,
  Eye,
  EyeOff,
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
  Trash2,
  UserCircle2,
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
  type TLUserPreferences,
  useIsDarkMode,
  useEditor,
  useTldrawUser,
  useValue
} from "tldraw";
import {
  GENERATION_PLACEHOLDER_TYPE,
  GenerationPlaceholderShapeUtil,
  type GenerationPlaceholderShape
} from "./GenerationPlaceholderShape";
import { AccountSettingsDialog } from "./AccountSettingsDialog";
import { AdminPage } from "./AdminPage";
import { AuthPage } from "./AuthPage";
import { CreditHistoryDialog } from "./CreditHistoryDialog";
import { ProviderConfigDialog } from "./ProviderConfigDialog";
import {
  CUSTOM_SIZE_PRESET_ID,
  GENERATION_COUNTS,
  IMAGE_SIZE_MULTIPLE,
  IMAGE_QUALITIES,
  MAX_IMAGE_ASPECT_RATIO,
  MAX_IMAGE_DIMENSION,
  MAX_REFERENCE_IMAGES,
  MAX_TOTAL_PIXELS,
  MIN_IMAGE_DIMENSION,
  MIN_TOTAL_PIXELS,
  OUTPUT_FORMATS,
  SIZE_PRESETS,
  STYLE_PRESETS,
  resolutionTierForSize,
  validateImageSize,
  type AppUser,
  type AuthMeResponse,
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
  type ImageSizeValidationReason,
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
import { LOCALES, localizedApiErrorMessage, useI18n, type Locale, type Translate } from "./i18n";

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
const TLDRAW_USER_ID = "gpt-image-canvas-local-user";

function tldrawLocaleForLocale(locale: Locale): NonNullable<TLUserPreferences["locale"]> {
  return locale === "zh-CN" ? "zh-cn" : "en";
}

function localeForTldrawLocale(locale: TLUserPreferences["locale"]): Locale | undefined {
  if (locale === "zh-cn") {
    return "zh-CN";
  }

  if (locale === "en") {
    return "en";
  }

  return undefined;
}

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
    labelKey: "promptStarterProductLabel",
    promptKey: "promptStarterProductPrompt"
  },
  {
    labelKey: "promptStarterInteriorLabel",
    promptKey: "promptStarterInteriorPrompt"
  },
  {
    labelKey: "promptStarterAvatarLabel",
    promptKey: "promptStarterAvatarPrompt"
  },
  {
    labelKey: "promptStarterCityLabel",
    promptKey: "promptStarterCityPrompt"
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
type AppRoute = "canvas" | "gallery" | "admin";
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

function missingReferenceSelection(t: Translate): ReferenceSelection {
  return {
    status: "none",
    hint: t("generationReferenceNeed", { max: MAX_REFERENCE_IMAGES })
  };
}

const historyStatusStyles: Record<GenerationStatus, string> = {
  pending: "history-status--pending",
  running: "history-status--running",
  succeeded: "history-status--succeeded",
  partial: "history-status--partial",
  failed: "history-status--failed",
  cancelled: "history-status--cancelled"
};

function sizePresetLabel(preset: SizePreset, t: Translate): string {
  return t("sizePresetLabel", { presetId: preset.id, fallback: preset.label });
}

function sizePresetOptionLabel(preset: SizePreset, t: Translate): string {
  return `${sizePresetLabel(preset, t)} - ${preset.width} x ${preset.height}`;
}

function normalizeDimension(value: string): number {
  return Number.parseInt(value, 10);
}

function sizeValidationMessage(width: number, height: number, t: Translate, locale: Locale): string {
  const result = validateImageSize({ width, height });

  if (result.ok) {
    return "";
  }

  return imageSizeValidationMessage(result.reason, t, locale);
}

function generationValidationMessage(promptValue: string, widthValue: number, heightValue: number, t: Translate, locale: Locale): string {
  return promptValue.trim() ? sizeValidationMessage(widthValue, heightValue, t, locale) : t("promptRequired");
}

function imageSizeValidationMessage(reason: ImageSizeValidationReason | undefined, t: Translate, locale: Locale): string {
  const numberFormat = new Intl.NumberFormat(locale);

  switch (reason) {
    case "non_integer":
      return t("imageSizeNonInteger");
    case "too_small":
      return t("imageSizeTooSmall", { min: MIN_IMAGE_DIMENSION });
    case "too_large":
      return t("imageSizeTooLarge", { max: MAX_IMAGE_DIMENSION });
    case "not_multiple":
      return t("imageSizeNotMultiple", { multiple: IMAGE_SIZE_MULTIPLE });
    case "aspect_ratio":
      return t("imageSizeAspectRatio", { maxRatio: MAX_IMAGE_ASPECT_RATIO });
    case "total_pixels_too_small":
      return t("imageSizeTotalTooSmall", { minPixels: numberFormat.format(MIN_TOTAL_PIXELS) });
    case "total_pixels_too_large":
      return t("imageSizeTotalTooLarge", { maxPixels: numberFormat.format(MAX_TOTAL_PIXELS) });
    case "unsupported_preset":
      return t("imageSizeUnsupportedPreset");
    default:
      return t("imageSizeUnsupportedPreset");
  }
}

function routeFromLocation(): AppRoute {
  if (window.location.pathname === "/gallery") {
    return "gallery";
  }

  if (window.location.pathname === "/admin") {
    return "admin";
  }

  return "canvas";
}

function pathForRoute(route: AppRoute): string {
  if (route === "gallery") {
    return "/gallery";
  }

  return route === "admin" ? "/admin" : "/canvas";
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

function generationFailureMessage(record: GenerationRecord, t: Translate): string {
  const summary = record.error?.trim();
  const firstFailure = failedOutputMessages(record)[0];

  if (firstFailure) {
    return summary && summary !== firstFailure ? t("generationFailureReason", { summary, reason: firstFailure }) : firstFailure;
  }

  return summary || t("generationNoSuccessfulImage");
}

function generationWarningMessage(record: GenerationRecord, insertedCount: number, failedCount: number, cloudFailedCount: number, t: Translate): string {
  const parts = [t("generationImageInsertedPart", { count: insertedCount })];
  if (failedCount > 0) {
    parts.push(t("generationFailedCount", { count: failedCount }));
  }
  if (cloudFailedCount > 0) {
    parts.push(t("generationCloudSavedButFailed", { count: cloudFailedCount }));
  }

  const firstFailure = failedOutputMessages(record)[0];
  const message = parts.join(t("commonListSeparator"));
  return firstFailure
    ? t("generationFailureReason", { summary: `${message}${t("commonSentenceEnd")}`, reason: firstFailure })
    : `${message}${t("commonSentenceEnd")}`;
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

function formatCreatedTime(value: string, formatDateTime: (value: string) => string): string {
  return formatDateTime(value);
}

function formatCodexExpiry(value: string, formatDateTime: (value: string, options?: Intl.DateTimeFormatOptions) => string, t: Translate): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return t("timeFallback15Minutes");
  }

  return formatDateTime(value, {
    hour: "2-digit",
    minute: "2-digit"
  });
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

function replaceGenerationPlaceholders(editor: Editor, placeholderSet: ActiveGenerationPlaceholders, record: GenerationRecord, t: Translate): number {
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
          error: output?.error || record.error || t("generationErrorDefault")
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

interface ImageJobView {
  id: string;
  mode: "generate" | "edit";
  status: "pending" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  record: GenerationRecord | null;
}

async function pollImageJob(jobId: string, signal: AbortSignal): Promise<ImageJobView> {
  const initialDelayMs = 1500;
  const maxDelayMs = 4000;
  const maxAttempts = 600; // ~40 分钟兜底；finally 一定会跑，正常情况下早就返回了
  let delayMs = initialDelayMs;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal.aborted) {
      throw new DOMException("Aborted.", "AbortError");
    }

    const response = await fetch(`/api/images/jobs/${encodeURIComponent(jobId)}`, { signal });
    if (!response.ok) {
      throw new Error(`生成状态查询失败，状态 ${response.status}。`);
    }
    const body = (await response.json()) as { job?: ImageJobView };
    if (!body.job) {
      throw new Error("生成任务返回内容无法识别。");
    }
    if (body.job.status !== "pending" && body.job.status !== "running") {
      return body.job;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      const onAbort = (): void => {
        cleanup();
        reject(new DOMException("Aborted.", "AbortError"));
      };
      const cleanup = (): void => {
        window.clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });

    delayMs = Math.min(maxDelayMs, Math.round(delayMs * 1.3));
  }

  throw new Error("生成任务超时未结束，请稍后到画廊查看或联系管理员。");
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

function resolveReferenceSelection(editor: Editor, t: Translate): ReferenceSelection {
  const selectedShapes = editor.getSelectedShapes();

  if (selectedShapes.length === 0) {
    return missingReferenceSelection(t);
  }

  if (selectedShapes.some((shape) => shape.type !== "image")) {
    return {
      status: "non-image",
      hint: t("generationSelectionNonImage", { max: MAX_REFERENCE_IMAGES })
    };
  }

  if (selectedShapes.length > MAX_REFERENCE_IMAGES) {
    return {
      status: "too-many",
      hint: t("generationSelectionTooMany", { count: selectedShapes.length, max: MAX_REFERENCE_IMAGES })
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
        hint: t("generationSelectionMissingSource")
      };
    }

    if (!isReadableReferenceSource(sourceUrl, asset)) {
      return {
        status: "unreadable",
        hint: t("generationSelectionUnreadable")
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
        ? t("generationSelectedReferenceOne")
        : t("generationSelectedReferenceMany", { count: sortedReferences.length })
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

async function blobToDataUrl(blob: Blob, t?: Translate): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t ? t("readReferenceDataFailed") : "Unable to read reference image data."));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error(t ? t("readReferenceDataFailed") : "Unable to read reference image data."));
    };
    reader.readAsDataURL(blob);
  });
}

async function readReferenceImage(selection: ReferenceSelectionItem, signal: AbortSignal, t: Translate): Promise<{
  dataUrl: string;
  fileName: string;
}> {
  let response: Response;

  try {
    response = await fetch(selection.sourceUrl, { signal });
  } catch {
    throw new Error(t("readReferenceFailed"));
  }

  if (!response.ok) {
    throw new Error(t("readReferenceMissingFile"));
  }

  const blob = await response.blob();
  if (!isSupportedReferenceImageType(blob.type)) {
    throw new Error(t("referenceInvalidType"));
  }
  if (blob.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(t("referenceFileTooLarge"));
  }

  return {
    dataUrl: await blobToDataUrl(blob, t),
    fileName: fileNameWithImageExtension(selection.name, blob.type)
  };
}

async function readStoredReferenceImage(assetId: string, signal: AbortSignal, t: Translate): Promise<ReferenceImageInput> {
  const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}`, { signal });
  if (!response.ok) {
    throw new Error(t("readStoredReferenceFailed"));
  }

  const blob = await response.blob();
  if (!isSupportedReferenceImageType(blob.type)) {
    throw new Error(t("referenceHistoryInvalidType"));
  }
  if (blob.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(t("referenceHistoryFileTooLarge"));
  }

  return {
    dataUrl: await blobToDataUrl(blob, t),
    fileName: fileNameWithImageExtension(assetId, blob.type)
  };
}

async function readErrorMessage(response: Response, locale: Locale, t: Translate): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return localizedApiErrorMessage({
      code: body.error?.code,
      fallbackMessage: body.error?.message,
      fallbackText: t("errorFallback", { status: response.status }),
      locale,
      status: response.status
    });
  } catch {
    return t("errorFallback", { status: response.status });
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

function showGenerationCompleteNotification(record: GenerationRecord, insertedCount: number, failedCount: number, t: Translate): void {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const isPartial = record.status === "partial" || failedCount > 0;
  const body = isPartial ? t("generationInsertedPartialBody", { inserted: insertedCount, failed: failedCount }) : t("generationImageInserted", { count: insertedCount });

  new Notification(isPartial ? t("generationNotificationPartialTitle") : t("generationNotificationTitle"), {
    body,
    icon: "/favicon.svg",
    tag: `generation-${record.id}`
  });
}

function saveStatusLabel(status: SaveStatus, t: Translate): string {
  switch (status) {
    case "loading":
      return t("saveStatusLoading");
    case "pending":
      return t("saveStatusPending");
    case "saving":
      return t("saveStatusSaving");
    case "error":
      return t("saveStatusError");
    case "saved":
    default:
      return t("saveStatusSaved");
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
    <p className="brand-name brand-name--zh" title="青云生图">
      <span className="brand-name__zh">青云生图</span>
    </p>
  );
}

function TopNavigation({
  currentUser,
  onLogout,
  onOpenProviderConfig,
  onOpenAccountSettings,
  onOpenCreditHistory,
  route,
  onNavigate,
  onPreloadGallery
}: {
  currentUser: AppUser;
  onLogout: () => void;
  onOpenProviderConfig: () => void;
  onOpenAccountSettings: () => void;
  onOpenCreditHistory: () => void;
  route: AppRoute;
  onNavigate: (route: AppRoute) => void;
  onPreloadGallery: () => void;
}) {
  const { t } = useI18n();
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const accountChipDisplayName = currentUser.nickname?.trim() || currentUser.username;

  useEffect(() => {
    if (!isAccountMenuOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setIsAccountMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsAccountMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAccountMenuOpen]);

  return (
    <header className="top-navigation">
      <div className="top-navigation__inner">
        <div className="brand-lockup min-w-0">
          <BrandMark />
          <div className="min-w-0">
            <BrandName />
            <p className="brand-tagline">{t("appTagline")}</p>
          </div>
        </div>
        <div className="top-navigation__actions">
          <nav aria-label={t("navMainAria")} className="top-navigation__links">
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
              {t("navCanvas")}
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
              {t("navGallery")}
            </a>
            {currentUser.role === "admin" ? (
              <a
                aria-current={route === "admin" ? "page" : undefined}
                className="top-navigation__link"
                data-active={route === "admin"}
                data-testid="nav-admin"
                href="/admin"
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate("admin");
                }}
              >
                <ShieldCheck className="size-4" aria-hidden="true" />
                后台
              </a>
            ) : null}
          </nav>
          <div className="account-chip-wrap" ref={accountMenuRef}>
            <button
              type="button"
              className="account-chip account-chip--button"
              title={`当前用户：${currentUser.username}`}
              data-testid="account-chip"
              aria-haspopup="menu"
              aria-expanded={isAccountMenuOpen}
              onClick={() => setIsAccountMenuOpen((open) => !open)}
            >
              <UserCircle2 className="size-4" aria-hidden="true" />
              <span>{accountChipDisplayName}</span>
              <strong>{currentUser.credits} 积分</strong>
            </button>
            {isAccountMenuOpen ? (
              <div className="account-menu" role="menu">
                <button
                  type="button"
                  className="account-menu__item"
                  role="menuitem"
                  onClick={() => {
                    setIsAccountMenuOpen(false);
                    onOpenAccountSettings();
                  }}
                >
                  账号设置
                </button>
                <button
                  type="button"
                  className="account-menu__item"
                  role="menuitem"
                  onClick={() => {
                    setIsAccountMenuOpen(false);
                    onOpenCreditHistory();
                  }}
                >
                  积分明细
                </button>
                <button
                  type="button"
                  className="account-menu__item account-menu__item--danger"
                  role="menuitem"
                  onClick={() => {
                    setIsAccountMenuOpen(false);
                    onLogout();
                  }}
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  退出登录
                </button>
              </div>
            ) : null}
          </div>
          {currentUser.role === "admin" ? (
            <button
              aria-label={t("navOpenProviderConfig")}
              className="top-navigation__settings"
              data-testid="global-provider-settings"
              title={t("navProviderConfig")}
              type="button"
              onClick={onOpenProviderConfig}
            >
              <Settings className="size-4" aria-hidden="true" />
              <span>{t("navSettings")}</span>
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="language-switcher" aria-label={t("languageAria")} role="group">
      {LOCALES.map((item) => (
        <button
          aria-pressed={locale === item}
          className="language-switcher__button"
          data-active={locale === item}
          key={item}
          type="button"
          onClick={() => setLocale(item)}
        >
          {item === "zh-CN" ? t("languageZh") : t("languageEn")}
        </button>
      ))}
    </div>
  );
}

function CanvasThemeSync({ onChange }: { onChange: (isDarkMode: boolean) => void }) {
  const isDarkMode = useIsDarkMode();

  useEffect(() => {
    onChange(isDarkMode);
  }, [isDarkMode, onChange]);

  return null;
}

function providerStatusDetails(authStatus: AuthStatusResponse | null, isAuthLoading: boolean, t: Translate): {
  copy: string;
  provider: "openai" | "codex" | "loading" | "none";
  title: string;
} {
  if (authStatus?.provider === "openai") {
    if (authStatus.activeSource?.id === "local-openai") {
      return {
        copy: t("providerStatusLocalCopy"),
        provider: "openai",
        title: t("providerStatusLocalTitle")
      };
    }

    if (authStatus.activeSource?.id === "env-openai") {
      return {
        copy: t("providerStatusEnvCopy"),
        provider: "openai",
        title: t("providerStatusEnvTitle")
      };
    }

    return {
      copy: t("providerStatusGenericOpenAICopy"),
      provider: "openai",
      title: "OpenAI API"
    };
  }

  if (authStatus?.provider === "codex") {
    return {
      copy: authStatus.codex.email ?? authStatus.codex.accountId ?? t("providerStatusCodexCopy"),
      provider: "codex",
      title: t("providerStatusCodexTitle")
    };
  }

  if (isAuthLoading) {
    return {
      copy: t("providerStatusLoadingCopy"),
      provider: "loading",
      title: t("providerStatusLoadingTitle")
    };
  }

  return {
    copy: t("providerStatusNoneCopy"),
    provider: "none",
    title: t("providerStatusNoneTitle")
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
  const { t } = useI18n();
  const details = providerStatusDetails(authStatus, isAuthLoading, t);
  const isCodexStarting = codexLoginStatus === "starting";

  return (
    <div className="provider-status-popover" data-provider={details.provider} data-testid="auth-provider-card">
      <button
        aria-label={t("providerStatusAria", { title: details.title })}
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
        <span className="control-label">{t("providerStatusImageService")}</span>
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
            title={t("providerLogoutCodex")}
            data-testid="codex-logout-button"
            disabled={isAuthLoading}
            onClick={onLogoutCodex}
          >
            <LogOut className="size-4" aria-hidden="true" />
            {t("providerLogoutCodex")}
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
            {t("providerLoginCodex")}
          </button>
        )}
      </div>
    </div>
  );
}

export function App() {
  const { formatDateTime, locale, setLocale, t } = useI18n();
  const tldrawLocale = tldrawLocaleForLocale(locale);
  const tldrawUserPreferences = useMemo<TLUserPreferences>(
    () => ({
      id: TLDRAW_USER_ID,
      locale: tldrawLocale
    }),
    [tldrawLocale]
  );
  const syncTldrawUserPreferences = useCallback(
    (preferences: TLUserPreferences) => {
      const nextLocale = localeForTldrawLocale(preferences.locale);
      if (nextLocale && nextLocale !== locale) {
        setLocale(nextLocale);
      }
    },
    [locale, setLocale]
  );
  const tldrawUser = useTldrawUser({
    userPreferences: tldrawUserPreferences,
    setUserPreferences: syncTldrawUserPreferences
  });
  const [route, setRoute] = useState<AppRoute>(() => routeFromLocation());
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
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
  const [hiddenHistoryIds, setHiddenHistoryIds] = useState<Set<string>>(new Set());
  const [isMobileDrawer, setIsMobileDrawer] = useState(false);
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const [isStorageDialogOpen, setIsStorageDialogOpen] = useState(false);
  const [isProviderConfigDialogOpen, setIsProviderConfigDialogOpen] = useState(false);
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false);
  const [isCreditHistoryOpen, setIsCreditHistoryOpen] = useState(false);
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
  const [referenceSelection, setReferenceSelection] = useState<ReferenceSelection>(() => missingReferenceSelection(t));
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
  const isAdmin = currentUser?.role === "admin";

  const trimmedPrompt = prompt.trim();
  const promptValidationMessage = prompt.trim() ? "" : t("promptRequired");
  const dimensionValidationMessage = sizeValidationMessage(width, height, t, locale);
  const creditValidationMessage = currentUser && currentUser.credits < count ? t("insufficientCredits", { count }) : "";
  const isReferenceMode = generationMode === "reference";
  const isReferenceReady = isReferenceMode && referenceSelection.status === "ready";
  const referenceValidationMessage = isReferenceMode && !isReferenceReady ? referenceSelection.hint : "";
  const validationMessage = promptValidationMessage || dimensionValidationMessage || referenceValidationMessage || creditValidationMessage;
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
  const loadCurrentUser = useCallback(async (signal?: AbortSignal): Promise<AppUser | null> => {
    setIsSessionLoading(true);

    try {
      const response = await fetch("/api/auth/me", { signal });
      if (!response.ok) {
        throw new Error(`Session load failed with ${response.status}`);
      }

      const body = (await response.json()) as AuthMeResponse;
      setCurrentUser(body.user);
      return body.user;
    } catch {
      if (!signal?.aborted) {
        setCurrentUser(null);
      }
      return null;
    } finally {
      if (!signal?.aborted) {
        setIsSessionLoading(false);
      }
    }
  }, []);
  const loadAuthStatus = useCallback(async (signal?: AbortSignal): Promise<AuthStatusResponse | null> => {
    setIsAuthLoading(true);
    setAuthError("");

    try {
      const response = await fetch("/api/auth/status", { signal });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, locale, t));
      }

      const status = (await response.json()) as AuthStatusResponse;
      setAuthStatus(status);
      return status;
    } catch (error) {
      if (signal?.aborted) {
        return null;
      }

      setAuthError(error instanceof Error ? error.message : t("authStatusLoadFailed"));
      return null;
    } finally {
      if (!signal?.aborted) {
        setIsAuthLoading(false);
      }
    }
  }, [locale, t]);

  const handleAuthenticated = useCallback((user: AppUser): void => {
    setCurrentUser(user);
    setProjectSnapshot(undefined);
    setGenerationHistory([]);
    setIsProjectLoaded(false);
    navigateToRoute("canvas", { replace: true });
  }, [navigateToRoute]);

  const logoutApp = useCallback(async (): Promise<void> => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setCurrentUser(null);
    setAuthStatus(null);
    setProjectSnapshot(undefined);
    setGenerationHistory([]);
    setIsProjectLoaded(false);
    navigateToRoute("canvas", { replace: true });
  }, [navigateToRoute]);

  const panelStatus = useMemo<PanelStatus | null>(() => {
    if (isGenerating) {
      return {
        tone: "progress",
        message: t("generationActiveTasks", { count: activeGenerationCount }),
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
    t,
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
    void loadCurrentUser(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadCurrentUser]);

  useEffect(() => {
    if (!currentUser) {
      return;
    }

    if (route === "admin" && currentUser.role !== "admin") {
      navigateToRoute("canvas", { replace: true });
    }
  }, [currentUser, navigateToRoute, route]);

  useEffect(() => {
    if (!currentUser) {
      setIsProjectLoaded(false);
      return;
    }

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
        setSaveError(t("projectLoadFailed"));
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
  }, [currentUser?.id, t]);

  useEffect(() => {
    if (!isAdmin) {
      setAuthStatus(null);
      setIsAuthLoading(false);
      return;
    }

    const controller = new AbortController();

    void loadAuthStatus(controller.signal);

    return () => {
      controller.abort();
    };
  }, [isAdmin, loadAuthStatus]);

  useEffect(() => {
    if (!currentUser) {
      setStorageConfig(null);
      return;
    }

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
          setStorageError(t("storageLoadFailed"));
        }
      }
    }

    void loadStorageConfig();

    return () => {
      controller.abort();
    };
  }, [currentUser?.id, t]);

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
  }, [t]);

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
        throw new Error(await readErrorMessage(response, locale, t));
      }

      const device = (await response.json()) as CodexDeviceStartResponse;
      setCodexDevice(device);
      setCodexLoginStatus("pending");
      setCodexLoginMessage(t("codexPendingAuth"));
      scheduleCodexPoll(device, device.interval);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("codexLoginFailedToStart");
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
        throw new Error(await readErrorMessage(response, locale, t));
      }

      const result = (await response.json()) as CodexDevicePollResponse;
      if (result.status === "authorized") {
        setCodexLoginStatus("authorized");
        setCodexLoginMessage(t("codexLoginAuthorized"));
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
      setCodexLoginMessage(result.message ?? t("codexLoginIncomplete"));
      void loadAuthStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("codexLoginPollingFailed");
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
        throw new Error(await readErrorMessage(response, locale, t));
      }

      const result = (await response.json()) as CodexLogoutResponse;
      setAuthStatus(result.auth);
      setCodexDevice(null);
      setCodexLoginStatus("idle");
      setCodexLoginMessage("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : t("codexLogoutFailed"));
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
        throw new Error(await readErrorMessage(response, locale, t));
      }

      const result = (await response.json()) as StorageTestResult;
      if (!result.ok) {
        setStorageError(result.message);
        return;
      }

      setStorageMessage(result.message);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : t("storageTestFailed"));
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
        throw new Error(await readErrorMessage(response, locale, t));
      }

      const config = (await response.json()) as StorageConfigResponse;
      setStorageConfig(config);
      setStorageForm(storageConfigToForm(config));
      setStorageSecretTouched(false);
      setStorageMessage(t("storageSaved"));
      setGenerationMessage(config.enabled ? t("storageEnabledMessage") : t("storageDisabledMessage"));
      setGenerationWarning("");
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : t("storageSaveFailed"));
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
      const nextSelection = resolveReferenceSelection(editor, t);
      setReferenceSelection((currentSelection) =>
        areReferenceSelectionsEqual(currentSelection, nextSelection) ? currentSelection : nextSelection
      );
      return;
    }

    setReferenceSelection((currentSelection) =>
      areReferenceSelectionsEqual(currentSelection, missingReferenceSelection(t)) ? currentSelection : missingReferenceSelection(t)
    );
  }, [generationMode, t]);

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

      const nextSelection = resolveReferenceSelection(editor, t);
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
          setSaveError(t("autosaveFailed"));
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
  }, [t]);

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

    const inputValidationMessage = generationValidationMessage(input.prompt, input.size.width, input.size.height, t, locale);
    if (inputValidationMessage) {
      setGenerationWarning(inputValidationMessage);
      return;
    }

    const editor = editorRef.current;
    if (!editor) {
      setGenerationError(t("generationCanvasNotReady"));
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
        throw new Error(t("generationRequireReference", { max: MAX_REFERENCE_IMAGES }));
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

      const submitResponse = await fetch(requestMode === "reference" ? "/api/images/edit" : "/api/images/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      if (!submitResponse.ok) {
        throw new Error(await readErrorMessage(submitResponse, locale, t));
      }

      const submitBody = (await submitResponse.json()) as { jobId?: string };
      if (!submitBody.jobId) {
        throw new Error(t("generationInvalidResponse"));
      }
      const jobId = submitBody.jobId;
      activeGenerationsRef.current.get(requestId)?.controller.signal.addEventListener("abort", () => {
        void fetch(`/api/images/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }).catch(() => undefined);
      });

      const finalJob = await pollImageJob(jobId, controller.signal);
      if (controller.signal.aborted || !activeGenerationsRef.current.has(requestId)) {
        return;
      }

      const meResponse = await fetch("/api/auth/me", { signal: controller.signal }).catch(() => undefined);
      if (meResponse?.ok) {
        const meBody = (await meResponse.json()) as { user?: AppUser | null };
        if (meBody.user) {
          setCurrentUser(meBody.user);
        }
      }

      if (!finalJob.record) {
        throw new Error(finalJob.errorMessage ?? t("generationInvalidResponse"));
      }

      const body = { record: finalJob.record };
      await preloadGenerationRecordPreviews(body.record, controller.signal);
      if (controller.signal.aborted || !activeGenerationsRef.current.has(requestId)) {
        return;
      }

      setGenerationHistory((history) =>
        [body.record, ...history.filter((record) => record.id !== temporaryRecord.id && record.id !== body.record.id)].slice(0, 20)
      );
      const insertedCount = replaceGenerationPlaceholders(editor, placeholderSet, body.record, t);
      const failedCount =
        body.record.outputs.filter((output) => output.status === "failed").length +
        Math.max(0, placeholderSet.placements.length - body.record.outputs.length);
      const cloudFailedCount = cloudFailureCount(body.record);
      if (insertedCount > 0) {
        if (cloudFailedCount > 0 || failedCount > 0) {
          setGenerationWarning(generationWarningMessage(body.record, insertedCount, failedCount, cloudFailedCount, t));
        } else {
          setGenerationMessage(t("generationImageInserted", { count: insertedCount }));
        }
        showGenerationCompleteNotification(body.record, insertedCount, failedCount, t);
      } else {
        setGenerationError(generationFailureMessage(body.record, t));
      }
    } catch (error) {
      if (controller.signal.aborted || !activeGenerationsRef.current.has(requestId)) {
        return;
      }

      const message = error instanceof Error ? error.message : t("generationErrorDefault");
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
          referenceImages: await Promise.all(referenceSelection.references.map((reference) => readReferenceImage(reference, signal, t))),
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
    setReferenceSelection(missingReferenceSelection(t));
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
      setGenerationError(t("generationCanvasNotReady"));
      return;
    }

    const shapeId = findCanvasImageShape(editor, record);
    if (!shapeId) {
      const activeTask = Array.from(activeGenerationsRef.current.values()).find((task) => task.temporaryRecordId === record.id);
      const placeholderId = activeTask ? firstLiveGenerationPlaceholder(editor, activeTask.placeholderSet) : undefined;
      if (!placeholderId) {
        setGenerationError(t("generationHistoryImageMissing"));
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
      setGenerationMessage(t("generationLocatePending"));
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
    setGenerationMessage(t("generationLocateSucceeded"));
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
            referenceImages: await Promise.all(referenceAssetIds.map((referenceAssetId) => readStoredReferenceImage(referenceAssetId, signal, t))),
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
      setGenerationError(t("generationDownloadNoAsset"));
      return;
    }

    window.open(`/api/assets/${encodeURIComponent(asset.id)}/download`, "_blank", "noopener,noreferrer");
    setGenerationMessage(t("generationDownloadOpened"));
  }

  function importGalleryImageToCanvas(item: GalleryImageItem): void {
    const editor = editorRef.current;
    if (!editor) {
      setGenerationError(t("generationCanvasNotReady"));
      navigateToRoute("canvas");
      return;
    }

    navigateToRoute("canvas");

    const viewportBounds = editor.getViewportPageBounds();
    const centerX = viewportBounds.x + viewportBounds.width / 2;
    const centerY = viewportBounds.y + viewportBounds.height / 2;
    const targetWidth = item.size.width;
    const targetHeight = item.size.height;
    const scale = Math.min(1, 800 / Math.max(targetWidth, targetHeight));
    const placedWidth = targetWidth * scale;
    const placedHeight = targetHeight * scale;
    const placement: GenerationPlaceholderPlacement = {
      id: createTldrawShapeId(),
      x: centerX - placedWidth / 2,
      y: centerY - placedHeight / 2,
      width: placedWidth,
      height: placedHeight,
      targetWidth,
      targetHeight
    };

    const asset = createImageAsset(item.asset);
    const shape = createImageShape(item.asset, placement, item.prompt);
    editor.run(() => {
      editor.createAssets([asset]);
      editor.createShapes([shape]);
    });
    editor.select(shape.id);
    setGenerationMessage(t("galleryImportedMessage", { count: 1 }));
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
    setGenerationMessage(t("generationGalleryReused"));
    navigateToRoute("canvas");
    if (isMobileDrawer) {
      setIsAiPanelOpen(true);
    }
  }

  useEffect(() => {
    if (!isProjectLoaded || generationHistory.length === 0) {
      return;
    }
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const nextHidden = new Set<string>();
    for (const record of generationHistory) {
      const shapeIds = getCanvasShapesForRecord(record);
      if (shapeIds.length === 0) {
        continue;
      }
      const allHidden = shapeIds.every((id) => {
        const shape = editor.getShape(id);
        return shape && shape.opacity === 0;
      });
      if (allHidden) {
        nextHidden.add(record.id);
      }
    }
    setHiddenHistoryIds((current) => {
      if (current.size === nextHidden.size && Array.from(current).every((id) => nextHidden.has(id))) {
        return current;
      }
      return nextHidden;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProjectLoaded, generationHistory.length]);

  function getCanvasShapesForRecord(record: GenerationRecord): TLShapeId[] {
    const editor = editorRef.current;
    if (!editor) {
      return [];
    }
    const assetIds = new Set(
      record.outputs.flatMap((output) => (output.status === "succeeded" && output.asset ? [output.asset.id] : []))
    );
    if (assetIds.size === 0) {
      return [];
    }
    const matched: TLShapeId[] = [];
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== "image") {
        continue;
      }
      const imageShape = shape as TLImageShape;
      const asset = imageShape.props.assetId ? editor.getAsset(imageShape.props.assetId) : undefined;
      const sourceUrl = getImageSourceUrl(imageShape, asset);
      const localAssetId = getLocalAssetId(asset, sourceUrl);
      if (localAssetId && assetIds.has(localAssetId)) {
        matched.push(imageShape.id);
      }
    }
    return matched;
  }

  function toggleHistoryRecordVisibility(record: GenerationRecord): void {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const shapeIds = getCanvasShapesForRecord(record);
    const currentlyHidden = hiddenHistoryIds.has(record.id);
    if (shapeIds.length > 0) {
      editor.run(() => {
        editor.updateShapes(shapeIds.map((id) => ({ id, type: "image", isLocked: !currentlyHidden, opacity: currentlyHidden ? 1 : 0 } as TLShapePartial<TLImageShape>)));
      });
    }
    setHiddenHistoryIds((current) => {
      const next = new Set(current);
      if (currentlyHidden) {
        next.delete(record.id);
      } else {
        next.add(record.id);
      }
      return next;
    });
  }

  async function deleteHistoryRecord(record: GenerationRecord): Promise<void> {
    const succeededCount = record.outputs.filter((output) => output.status === "succeeded" && output.asset).length;
    const confirmMessage = succeededCount > 0
      ? t("historyDeleteConfirmWithSuccess", { count: succeededCount })
      : t("historyDeleteConfirm");
    if (!window.confirm(confirmMessage)) {
      return;
    }

    const isLocalOnly = record.id.startsWith("local-generation-");
    const editor = editorRef.current;
    const shapeIds = editor ? getCanvasShapesForRecord(record) : [];
    if (editor && shapeIds.length > 0) {
      editor.deleteShapes(shapeIds);
    }
    setGenerationHistory((history) => history.filter((item) => item.id !== record.id));
    setHiddenHistoryIds((current) => {
      const next = new Set(current);
      next.delete(record.id);
      return next;
    });
    if (isLocalOnly) {
      // 临时 record（请求失败、还没写入 DB）只清前端历史，不调后端
      return;
    }
    try {
      const response = await fetch(`/api/generations/${encodeURIComponent(record.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const message = await readErrorMessage(response, locale, t).catch(() => t("historyDeleteHttpError", { status: response.status }));
        setGenerationError(message);
      }
    } catch {
      setGenerationError(t("historyDeleteFailed"));
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
      setGenerationError(t("generationMissingPromptHistory"));
      return;
    }

    try {
      await writeClipboardText(promptText);
      setGenerationMessage(t("generationCopiedPrompt"));
    } catch {
      setGenerationError(t("generationCopyFailed"));
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
        record.id === task.temporaryRecordId ? { ...record, status: "cancelled", error: t("generationUnknownCancel") } : record
      )
    );
    setGenerationError("");
    setGenerationMessage(t("generationUnknownCancel"));
    setGenerationWarning("");
  }

  if (isSessionLoading) {
    return (
      <div className="app-root">
        <main className="auth-page app-view" role="status">
          <div className="canvas-loading-state">
            <BrandMark className="brand-mark--large" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-neutral-800">正在载入账号</p>
              <p className="mt-1 text-xs text-neutral-500">请稍候</p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="app-root">
        <AuthPage onAuthenticated={handleAuthenticated} />
      </div>
    );
  }

  return (
    <div className="app-root" data-canvas-theme={route === "canvas" && isCanvasDarkMode ? "dark" : "light"}>
      <TopNavigation
        currentUser={currentUser}
        route={route}
        onLogout={() => void logoutApp()}
        onNavigate={navigateToRoute}
        onOpenProviderConfig={() => setIsProviderConfigDialogOpen(true)}
        onOpenAccountSettings={() => setIsAccountSettingsOpen(true)}
        onOpenCreditHistory={() => setIsCreditHistoryOpen(true)}
        onPreloadGallery={preloadGalleryPage}
      />
      {isAccountSettingsOpen ? (
        <AccountSettingsDialog
          currentUser={currentUser}
          onClose={() => setIsAccountSettingsOpen(false)}
          onProfileUpdated={(user) => setCurrentUser(user)}
          onPasswordChanged={() => {
            setIsAccountSettingsOpen(false);
            void logoutApp();
          }}
          onRedeemed={(user) => setCurrentUser(user)}
        />
      ) : null}
      {isCreditHistoryOpen ? (
        <CreditHistoryDialog onClose={() => setIsCreditHistoryOpen(false)} />
      ) : null}
      <main className="app-shell app-view relative flex min-h-0 overflow-hidden bg-neutral-950 text-neutral-900" data-active-route={route} hidden={route !== "canvas"}>
      <section
        className="relative min-w-0 flex-1 bg-neutral-100 outline-none"
        aria-label={t("appCanvasAria")}
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
            user={tldrawUser}
            onMount={handleEditorMount}
          />
        ) : (
          <div className="canvas-loading-state">
            <BrandMark className="brand-mark--large" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-neutral-800">{t("canvasLoadingTitle")}</p>
              <p className="mt-1 text-xs text-neutral-500">{t("appTagline")}</p>
            </div>
          </div>
        )}
      </section>

      {isMobileDrawer && isAiPanelOpen ? (
        <button
          aria-label={t("generationPanelClose")}
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
        {t("generationStartText")}
      </button>

      <aside
        aria-hidden={isMobileDrawer && !isAiPanelOpen ? true : undefined}
        aria-label={t("generationPanelAria")}
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
                <p className="brand-tagline">{t("appTagline")}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                aria-label={t("storageSettings")}
                className={`cloud-storage-toggle ${storageConfig?.enabled ? "cloud-storage-toggle--on" : "cloud-storage-toggle--off"}`}
                data-testid="storage-settings-button"
                title={storageConfig?.enabled ? t("storageEnabledTitle") : t("storageSettings")}
                type="button"
                onClick={openStorageDialog}
              >
                <Cloud className="size-4" aria-hidden="true" />
                <span>{storageConfig?.enabled ? "云存储已开" : "云存储"}</span>
              </button>
              <div
                className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${
                  saveStatus === "error" ? "bg-red-50 text-red-700" : "bg-neutral-100 text-neutral-600"
                }`}
                data-testid="save-status"
                role="status"
              >
                <SaveStatusIcon status={saveStatus} />
                {saveStatusLabel(saveStatus, t)}
              </div>
              <button
                aria-label={t("generationPanelClose")}
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
            <span className="control-label">{t("generationModeLabel")}</span>
            <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label={t("generationModeAria")}>
              <button
                className={generationMode === "text" ? "segmented-control h-9 text-xs is-active" : "segmented-control h-9 text-xs"}
                type="button"
                aria-pressed={generationMode === "text"}
                data-testid="mode-text"
                onClick={() => setGenerationMode("text")}
              >
                {t("modeLabel", { mode: "generate" })}
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
                {t("modeLabel", { mode: "edit" })}
              </button>
            </div>
          </div>

          <label className="block">
            <span className="control-label">{t("generationPromptLabel")}</span>
            <textarea
              aria-invalid={Boolean(promptValidationMessage)}
              className="prompt-textarea mt-2 h-32 w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm leading-6 text-neutral-950 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
              id="prompt-input"
              name="prompt"
              placeholder={t("generationPromptPlaceholder")}
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
                  key={starter.labelKey}
                  type="button"
                  title={t(starter.promptKey)}
                  data-testid="prompt-starter-chip"
                  onClick={() => applyPromptStarter(t(starter.promptKey))}
                >
                  {t(starter.labelKey)}
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
                      ? t("generationReferenceReady", { count: referenceSelection.references.length })
                      : t("generationReferenceNeed", { max: MAX_REFERENCE_IMAGES })}
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
                            alt={t("generationReferenceAlt", { index: index + 1, name: reference.name })}
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
                        {t("generationCancelReference")}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          <label className="block">
            <span className="control-label">{t("generationStyleLabel")}</span>
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
                  {t("stylePresetLabel", { presetId: preset.id, fallback: preset.label })}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className="control-label">{t("generationSizeLabel")}</span>
            <div className="quick-size-grid" data-testid="quick-size-presets">
              {quickSizePresets.map((preset) => (
                <button
                  aria-pressed={sizePresetId === preset.id}
                  className={sizePresetId === preset.id ? "quick-size-button is-active" : "quick-size-button"}
                  key={preset.id}
                  type="button"
                  onClick={() => selectScenePreset(preset.id)}
                >
                  <span>{sizePresetLabel(preset, t)}</span>
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
                <span>{t("customSize")}</span>
                <small>{t("customSizeManual")}</small>
              </button>
            </div>
            <label className="mt-3 block">
              <span className="sr-only">{t("generationAllSizes")}</span>
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
                    {sizePresetOptionLabel(preset, t)}
                  </option>
                ))}
                <option value={CUSTOM_SIZE_PRESET_ID}>{t("customSizeOption")}</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="control-label">{t("generationWidthLabel")}</span>
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
              <span className="control-label">{t("generationHeightLabel")}</span>
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
            <span className="control-label">{t("generationCountLabel")}</span>
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
                <span>{isExtendedCountSelected ? t("generationMoreCountSelected", { count }) : t("generationMoreCount")}</span>
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
              {t("generationAdvanced")}
              <ChevronDown className="size-4 text-neutral-500" aria-hidden="true" />
            </summary>
            <div className="space-y-4 border-t border-neutral-200 px-3 py-4">
              <label className="block">
                <span className="control-label">{t("generationQualityLabel")}</span>
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
                      {t("qualityLabel", { quality: item })}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="control-label">{t("generationOutputFormatLabel")}</span>
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
                      {t("outputFormatLabel", { format: item })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </details>

          <section className="space-y-3" data-history-expanded={isHistoryExpanded} data-testid="generation-history">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-neutral-950">{t("generationHistoryTitle")}</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-500">{t("generationHistoryCount", { count: generationHistory.length })}</span>
                {hasAdditionalHistory ? (
                  <button
                    aria-expanded={isHistoryExpanded}
                    className="history-toggle"
                    data-testid="history-toggle"
                    type="button"
                    onClick={() => setIsHistoryExpanded((expanded) => !expanded)}
                  >
                    {isHistoryExpanded ? t("galleryToggleCollapse") : t("generationHistoryExpand", { count: hiddenHistoryCount })}
                    <ChevronDown className={`size-3.5 transition ${isHistoryExpanded ? "rotate-180" : ""}`} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>

            {generationHistory.length === 0 ? (
              <p className="rounded-md border border-dashed border-neutral-300 px-3 py-4 text-sm text-neutral-500">
                {t("generationEmptyHistory")}
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
                  const isRecordHidden = hiddenHistoryIds.has(record.id);

                  return (
                    <article
                      className="history-item"
                      data-testid="history-record"
                      key={record.id}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`history-status-pill ${historyStatusStyles[record.status]}`}>
                            {t("statusLabel", { status: record.status })}
                          </span>
                          <span className="truncate text-xs text-neutral-500">{t("modeLabel", { mode: record.mode })}</span>
                        </div>
                        <p className="mt-1 truncate text-sm font-medium leading-5 text-neutral-950" title={record.prompt}>
                          {excerpt}
                        </p>
                        <dl className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs leading-5 text-neutral-500">
                          <div className="inline-flex items-center gap-1">
                            <dt className="sr-only">{t("generationHistorySize")}</dt>
                            <dd>
                              {record.size.width} x {record.size.height}
                            </dd>
                          </div>
                          <div className="inline-flex items-center gap-1">
                            <dt className="sr-only">{t("generationHistoryOutputCount")}</dt>
                            <dd>
                              {t("generationImageOutputCount", { successful: successfulOutputCount(record), total: totalOutputs })}
                            </dd>
                          </div>
                          <div className="inline-flex items-center gap-1">
                            <dt className="sr-only">{t("generationHistoryCreatedAt")}</dt>
                            <dd>{formatCreatedTime(record.createdAt, formatDateTime)}</dd>
                          </div>
                          {cloudFailedCount > 0 ? (
                            <div className="inline-flex items-center gap-1 text-amber-700" title={cloudFailureMessage}>
                              <dt className="sr-only">{t("generationHistoryCloudBackup")}</dt>
                              <dd className="inline-flex items-center gap-1">
                                <Cloud className="size-3" aria-hidden="true" />
                                {t("generationCloudFailed", { count: cloudFailedCount })}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      </div>

                      <div className="history-actions">
                        <button
                          aria-label={t("generationHistoryCopyPrompt", { excerpt })}
                          className="history-icon-action"
                          type="button"
                          data-testid="history-copy-prompt"
                          title={t("galleryPromptLabel")}
                          onClick={() => void copyHistoryPrompt(record)}
                        >
                          <Copy className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          aria-label={t("generationHistoryLocate", { excerpt })}
                          className="history-icon-action"
                          type="button"
                          data-testid="history-locate"
                          title={t("historyLocate")}
                          onClick={() => locateHistoryRecord(record)}
                        >
                          <MapPin className="size-4" aria-hidden="true" />
                        </button>
                        <button
                          aria-label={t("generationHistoryRerun", { excerpt })}
                          className="history-icon-action"
                          type="button"
                          data-testid="history-rerun"
                          disabled={isRecordRunning}
                          title={isRecordRunning ? t("generationRerunRunning") : t("historyRerun")}
                          onClick={() => void rerunHistoryRecord(record)}
                        >
                          <RotateCcw className="size-4" aria-hidden="true" />
                        </button>
                        {activeTask && record.status === "running" ? (
                          <button
                            aria-label={t("historyCancelTask", { excerpt })}
                            className="history-icon-action"
                            type="button"
                            data-testid="history-cancel"
                            title={t("commonCancel")}
                            onClick={() => cancelGeneration(activeTask.requestId)}
                          >
                            <XCircle className="size-4" aria-hidden="true" />
                          </button>
                        ) : (
                          <button
                            aria-label={t("generationHistoryDownload", { excerpt })}
                            className="history-icon-action"
                            type="button"
                            data-testid="history-download"
                            disabled={!downloadableAsset}
                            title={downloadableAsset ? t("commonDownload") : t("generationHistoryNoDownload")}
                            onClick={() => downloadHistoryRecord(record)}
                          >
                            <Download className="size-4" aria-hidden="true" />
                          </button>
                        )}
                        <button
                          className="history-icon-action"
                          type="button"
                          data-testid="history-toggle-visibility"
                          title={isRecordHidden ? t("historyShowOnCanvas") : t("historyHideOnCanvas")}
                          onClick={() => toggleHistoryRecordVisibility(record)}
                        >
                          {isRecordHidden ? <Eye className="size-4" aria-hidden="true" /> : <EyeOff className="size-4" aria-hidden="true" />}
                        </button>
                        <button
                          className="history-icon-action history-icon-action--danger"
                          type="button"
                          data-testid="history-delete"
                          title={t("historyDeleteTitle")}
                          onClick={() => void deleteHistoryRecord(record)}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </button>
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
            {generationMode === "reference" ? t("generationStartReference") : t("generationStartText")}
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
                  {t("storageSettings")}
                </h2>
                <p className="mt-1 text-xs leading-5 text-neutral-500">{t("storageSubtitle")}</p>
              </div>
              <button
                aria-label={t("storageClose")}
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

              <div className="rounded-md border border-cyan-200 bg-cyan-50 px-3 py-3 text-xs leading-6 text-cyan-900">
                <p className="font-semibold">这是你自己的云存储</p>
                <p>
                  每个用户在这里独立配置自己的腾讯云 COS。开启后，生图时会同步上传一份到你的云端，
                  本地磁盘清掉后画布和画廊仍然能从你云端取回。
                </p>

                <p className="mt-3 font-semibold">开通腾讯云 COS</p>
                <ol className="mt-1 ml-4 list-decimal space-y-1">
                  <li>
                    登录 <a className="underline" href="https://console.cloud.tencent.com/cos" target="_blank" rel="noreferrer">腾讯云 COS 控制台</a>，创建一个存储桶（Bucket），区域选离你近的（例如 ap-shanghai）
                  </li>
                  <li>
                    到 <a className="underline" href="https://console.cloud.tencent.com/cam/capi" target="_blank" rel="noreferrer">访问密钥</a> 页面，新建一对 SecretId / SecretKey
                  </li>
                  <li>把 SecretId、SecretKey、Bucket、Region 填到下面的表单</li>
                  <li>勾选"开启"后点保存，系统会先做一次测试上传 / 删除验证</li>
                  <li>验证通过后，新生成的图会自动同时上传到你的云端</li>
                </ol>

                <p className="mt-3 font-semibold">空间参考</p>
                <p>
                  1K 单张约 1–4 MB · 2K 约 4–10 MB · 4K 约 20–40 MB。
                  腾讯云 COS 标准存储 ¥0.099 / GB / 月，1 GB 的月费几乎可以忽略。
                </p>
              </div>

              <label className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-3">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-neutral-900">{t("storageEnabledLabel")}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-neutral-500">{t("storageEnabledCopy")}</span>
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
                {t("storageTest")}
              </button>
              <button
                className="primary-action h-10"
                data-testid="storage-save"
                disabled={isStorageSaving || isStorageTesting}
                type="button"
                onClick={() => void saveStorageSettings()}
              >
                {isStorageSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="size-4" aria-hidden="true" />}
                {t("storageSave")}
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
                <h2 id="codex-login-title">{t("codexLoginTitle")}</h2>
                <p>{t("codexLoginSubtitle")}</p>
              </div>
              <button
                aria-label={t("codexCloseLogin")}
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
                  {t("codexCreatingCode")}
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
                      {t("codexOpenLoginPage")}
                    </a>
                    <button className="secondary-action h-10" type="button" onClick={() => void copyCodexUserCode()}>
                      <Copy className="size-4" aria-hidden="true" />
                      {t("codexCopyCode")}
                    </button>
                  </div>
                  <p className="codex-login-dialog__hint">
                    {t("codexCodeExpires", { time: formatCodexExpiry(codexDevice.expiresAt, formatDateTime, t) })}
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
                  {t("codexRestart")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
        ),
        document.body
      ) : null}
      </main>
      {isProviderConfigDialogOpen && isAdmin ? (
        <ProviderConfigDialog
          isAuthLoading={isAuthLoading}
          isCodexStarting={codexLoginStatus === "starting"}
          onClose={closeProviderConfigDialog}
          onLogoutCodex={logoutCodexSession}
          onRefreshAuthStatus={loadAuthStatus}
          onStartCodexLogin={startCodexLogin}
        />
      ) : null}
      {route === "admin" && currentUser.role === "admin" ? <AdminPage /> : null}
      {route === "gallery" ? (
        <Suspense
          fallback={
            <main className="gallery-page app-view" data-testid="gallery-loading-page">
              <div className="gallery-empty-state gallery-empty-state--boot" role="status">
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                <p>{t("galleryLoading")}</p>
              </div>
            </main>
          }
        >
          <LazyGalleryPage onDeleted={removeGalleryOutputFromHistory} onReuse={reuseGalleryImage} onImport={importGalleryImageToCanvas} />
        </Suspense>
      ) : null}
    </div>
  );
}
