import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Copy,
  Download,
  ImageIcon,
  Loader2,
  MapPin,
  RotateCcw,
  Sparkles,
  Square,
  X,
  XCircle
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type TldrawOptions
} from "tldraw";
import {
  GENERATION_PLACEHOLDER_TYPE,
  GenerationPlaceholderShapeUtil,
  type GenerationPlaceholderShape
} from "./GenerationPlaceholderShape";
import {
  CUSTOM_SIZE_PRESET_ID,
  GENERATION_COUNTS,
  IMAGE_QUALITIES,
  MAX_IMAGE_DIMENSION,
  MIN_IMAGE_DIMENSION,
  OUTPUT_FORMATS,
  SIZE_PRESETS,
  STYLE_PRESETS,
  validateImageSize,
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
  type SizePreset,
  type StylePresetId
} from "@gpt-image-canvas/shared";

const AUTOSAVE_DEBOUNCE_MS = 1200;
const HISTORY_COLLAPSED_LIMIT = 3;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const MOBILE_DRAWER_MEDIA_QUERY = "(max-width: 1023px)";
const ASSET_PREVIEW_WIDTHS = [256, 512, 1024, 2048] as const;
const SUPPORTED_REFERENCE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const shapeUtils = [GenerationPlaceholderShapeUtil];
const tldrawOptions = {
  debouncedZoomThreshold: 80
} satisfies Partial<TldrawOptions>;

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

type PersistedSnapshot = TLEditorSnapshot | TLStoreSnapshot;
type SaveStatus = "loading" | "saved" | "pending" | "saving" | "error";
type GenerationMode = "text" | "reference";
type PanelStatusTone = "progress" | "success" | "warning" | "error";

interface PanelStatus {
  tone: PanelStatusTone;
  message: string;
  testId: "generation-progress" | "generation-message" | "validation-message" | "generation-error";
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
  referenceImage: ReferenceImageInput;
  referenceAssetId?: string;
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

type ReferenceSelection =
  | {
      status: "none" | "multiple" | "non-image" | "unreadable";
      hint: string;
    }
  | {
      status: "ready";
      assetId: TLAssetId | null;
      localAssetId?: string;
      name: string;
      sourceUrl: string;
      width: number;
      height: number;
      hint: string;
    };

const missingReferenceSelection: ReferenceSelection = {
  status: "none",
  hint: "选择画布中的一张图片后，可用它作为参考生成新图。"
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
  generate: "提示词生成",
  edit: "参考生成"
};

const statusLabels: Record<GenerationStatus, string> = {
  pending: "等待中",
  running: "生成中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消"
};

const panelStatusStyles: Record<PanelStatusTone, string> = {
  progress: "border-blue-200 bg-blue-50 text-blue-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  error: "border-red-200 bg-red-50 text-red-800"
};

const historyStatusStyles: Record<GenerationStatus, string> = {
  pending: "bg-blue-50 text-blue-700",
  running: "bg-blue-50 text-blue-700",
  succeeded: "bg-emerald-50 text-emerald-700",
  partial: "bg-amber-50 text-amber-700",
  failed: "bg-red-50 text-red-700",
  cancelled: "bg-neutral-100 text-neutral-500"
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

function isPersistedSnapshot(value: unknown): value is PersistedSnapshot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGenerationResponse(value: unknown): value is GenerationResponse {
  return typeof value === "object" && value !== null && "record" in value;
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

function generationModeToRecordMode(mode: GenerationMode): GenerationRecord["mode"] {
  return mode === "reference" ? "edit" : "generate";
}

function createTemporaryGenerationRecord(input: {
  requestId: number;
  submitInput: GenerationSubmitInput;
  requestMode: GenerationMode;
  referenceAssetId?: string;
}): GenerationRecord {
  const promptValue = input.submitInput.prompt.trim();

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
    referenceAssetId: input.referenceAssetId,
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
  const columns = countValue === 1 ? 1 : 2;
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
          error: output?.error || record.error || "图像生成失败。"
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

  if (selectedShapes.length > 1) {
    return {
      status: "multiple",
      hint: "当前选择了多个对象。只选择一张图片即可启用参考生成。"
    };
  }

  const shape = selectedShapes[0];
  if (shape.type !== "image") {
    return {
      status: "non-image",
      hint: "当前对象不是图片。请选择画布中的单张图片作为参考。"
    };
  }

  const imageShape = shape as TLImageShape;
  const asset = imageShape.props.assetId ? editor.getAsset(imageShape.props.assetId) : undefined;
  const sourceUrl = getImageSourceUrl(imageShape, asset);

  if (!sourceUrl) {
    return {
      status: "unreadable",
      hint: "这张图片缺少可读取的数据源，无法作为参考图。"
    };
  }

  if (!isReadableReferenceSource(sourceUrl, asset)) {
    return {
      status: "unreadable",
      hint: "这张图片当前无法被浏览器读取，请选择本地生成或已导入的 PNG、JPEG、WebP 图片。"
    };
  }

  return {
    status: "ready",
    assetId: imageShape.props.assetId,
    localAssetId: getLocalAssetId(asset, sourceUrl),
    name: getReferenceName(asset, sourceUrl),
    sourceUrl,
    width: asset?.type === "image" ? asset.props.w : imageShape.props.w,
    height: asset?.type === "image" ? asset.props.h : imageShape.props.h,
    hint: "已选中一张图片，将使用它作为本次参考图。"
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
    left.assetId === right.assetId &&
    left.localAssetId === right.localAssetId &&
    left.name === right.name &&
    left.sourceUrl === right.sourceUrl &&
    left.width === right.width &&
    left.height === right.height &&
    left.hint === right.hint
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

  return `/api/assets/${encodeURIComponent(localAssetId)}/preview?width=${previewWidthForAssetContext(asset, context)}`;
}

function previewWidthForAssetContext(asset: Extract<TLAsset, { type: "image" }>, context: TLAssetContext): number {
  const dpr = Number.isFinite(context.dpr) && context.dpr > 0 ? context.dpr : window.devicePixelRatio || 1;
  const requestedWidth = Math.max(1, Math.ceil(asset.props.w * context.screenScale * dpr));
  return ASSET_PREVIEW_WIDTHS.find((widthValue) => widthValue >= requestedWidth) ?? ASSET_PREVIEW_WIDTHS[ASSET_PREVIEW_WIDTHS.length - 1];
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

async function readReferenceImage(selection: Extract<ReferenceSelection, { status: "ready" }>, signal: AbortSignal): Promise<{
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
    ? `已插入 ${insertedCount} 张图像，${failedCount} 张失败。`
    : `已插入 ${insertedCount} 张图像。`;

  new Notification(isPartial ? "图像生成部分完成" : "图像生成完成", {
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

function PanelStatusIcon({ tone }: { tone: PanelStatusTone }) {
  if (tone === "progress") {
    return <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />;
  }

  if (tone === "success") {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />;
  }

  if (tone === "warning") {
    return <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />;
  }

  return <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />;
}

export function App() {
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
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [isProjectLoaded, setIsProjectLoaded] = useState(false);
  const [projectSnapshot, setProjectSnapshot] = useState<PersistedSnapshot | undefined>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [saveError, setSaveError] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [generationMessage, setGenerationMessage] = useState("");
  const [generationHistory, setGenerationHistory] = useState<GenerationRecord[]>([]);
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const [isMobileDrawer, setIsMobileDrawer] = useState(false);
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const [referenceSelection, setReferenceSelection] = useState<ReferenceSelection>(missingReferenceSelection);
  const canvasShellRef = useRef<HTMLElement | null>(null);
  const panelCloseButtonRef = useRef<HTMLButtonElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const generationModeRef = useRef<GenerationMode>("text");
  const activeGenerationsRef = useRef<Map<number, ActiveGenerationTask>>(new Map());
  const generationRequestRef = useRef(0);
  const saveTimerRef = useRef<number | undefined>();
  const saveRequestRef = useRef(0);
  const isGenerating = activeGenerationCount > 0;

  const trimmedPrompt = prompt.trim();
  const promptValidationMessage = prompt.trim() ? "" : "请输入提示词。";
  const dimensionValidationMessage = sizeValidationMessage(width, height);
  const validationMessage = ((hasSubmitted || Boolean(dimensionValidationMessage)) && promptValidationMessage) || dimensionValidationMessage;
  const shouldShowValidation = Boolean(validationMessage);
  const isReferenceMode = generationMode === "reference";
  const isReferenceReady = isReferenceMode && referenceSelection.status === "ready";
  const canGenerate = !dimensionValidationMessage && (generationMode === "text" || isReferenceReady);

  const visibleHistory = useMemo(
    () => (isHistoryExpanded ? generationHistory : generationHistory.slice(0, HISTORY_COLLAPSED_LIMIT)),
    [generationHistory, isHistoryExpanded]
  );
  const hiddenHistoryCount = Math.max(0, generationHistory.length - HISTORY_COLLAPSED_LIMIT);
  const hasAdditionalHistory = hiddenHistoryCount > 0;
  const panelStatus = useMemo<PanelStatus | null>(() => {
    if (isGenerating) {
      return {
        tone: "progress",
        message: `当前 ${activeGenerationCount} 个任务生成中，可继续下发新任务。`,
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

    if (generationMessage) {
      return {
        tone: "success",
        message: generationMessage,
        testId: "generation-message"
      };
    }

    return null;
  }, [activeGenerationCount, generationError, generationMessage, isGenerating, shouldShowValidation, validationMessage]);

  useEffect(() => {
    return () => {
      for (const task of activeGenerationsRef.current.values()) {
        task.controller.abort();
      }
      activeGenerationsRef.current.clear();
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
    setHasSubmitted(false);
    setGenerationError("");
    setGenerationMessage("");
  }

  async function executeGeneration(
    input: GenerationSubmitInput,
    requestMode: GenerationMode,
    resolveReference?: (signal: AbortSignal) => Promise<GenerationReferenceInput | undefined>,
    referenceAssetId?: string
  ): Promise<void> {
    setHasSubmitted(true);
    setGenerationError("");
    setGenerationMessage("");

    const inputValidationMessage = generationValidationMessage(input.prompt, input.size.width, input.size.height);
    if (inputValidationMessage) {
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
      referenceAssetId
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
      if (requestMode === "reference" && !referenceForRequest) {
        throw new Error("请先选择一张可用的参考图像。");
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
        requestBody.referenceImage = referenceForRequest.referenceImage;
        if (referenceForRequest.referenceAssetId) {
          requestBody.referenceAssetId = referenceForRequest.referenceAssetId;
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

      setGenerationHistory((history) =>
        [body.record, ...history.filter((record) => record.id !== temporaryRecord.id && record.id !== body.record.id)].slice(0, 20)
      );
      const insertedCount = replaceGenerationPlaceholders(editor, placeholderSet, body.record);
      const failedCount =
        body.record.outputs.filter((output) => output.status === "failed").length +
        Math.max(0, placeholderSet.placements.length - body.record.outputs.length);
      if (insertedCount > 0) {
        setGenerationMessage(
          failedCount > 0
            ? `已插入 ${insertedCount} 张图像，${failedCount} 张失败。`
            : `已插入 ${insertedCount} 张图像。`
        );
        showGenerationCompleteNotification(body.record, insertedCount, failedCount);
      } else {
        setGenerationError(body.record.error || "没有可插入的成功图像。");
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

        return {
          referenceImage: await readReferenceImage(referenceSelection, signal),
          referenceAssetId: referenceSelection.localAssetId
        };
      }, referenceSelection.status === "ready" ? referenceSelection.localAssetId : undefined);
      return;
    }

    await executeGeneration(input, "text");
  }

  function cancelReferenceSelection(): void {
    editorRef.current?.selectNone();
    setReferenceSelection(missingReferenceSelection);
    setGenerationError("");
    setGenerationMessage("");
  }

  function locateHistoryRecord(record: GenerationRecord): void {
    setGenerationError("");
    setGenerationMessage("");

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

    const nextGenerationMode: GenerationMode = record.referenceAssetId ? "reference" : "text";
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
      record.referenceAssetId
        ? async (signal) => ({
            referenceImage: await readStoredReferenceImage(record.referenceAssetId!, signal),
            referenceAssetId: record.referenceAssetId
          })
        : undefined,
      record.referenceAssetId
    );
  }

  function downloadHistoryRecord(record: GenerationRecord): void {
    const asset = firstDownloadableAsset(record);
    if (!asset) {
      setGenerationError("这条历史记录没有可下载的本地资源。");
      return;
    }

    window.open(`/api/assets/${encodeURIComponent(asset.id)}/download`, "_blank", "noopener,noreferrer");
    setGenerationMessage("已打开原始资源下载。");
  }

  async function copyHistoryPrompt(record: GenerationRecord): Promise<void> {
    const promptText = record.prompt.trim();
    setGenerationError("");
    setGenerationMessage("");

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
  }

  return (
    <main className="app-shell relative flex h-dvh min-h-[640px] overflow-hidden bg-neutral-950 text-neutral-900">
      <section
        className="relative min-w-0 flex-1 bg-neutral-100 outline-none"
        aria-label="tldraw 创作画布"
        data-testid="canvas-shell"
        ref={canvasShellRef}
        tabIndex={-1}
      >
        {isProjectLoaded ? (
          <Tldraw
            assets={canvasAssetStore}
            options={tldrawOptions}
            snapshot={projectSnapshot}
            shapeUtils={shapeUtils}
            onMount={handleEditorMount}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">正在载入画布...</div>
        )}
      </section>

      {isMobileDrawer && isAiPanelOpen ? (
        <button
          aria-label="关闭 AI 生成面板"
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
        AI 生成
      </button>

      <aside
        aria-hidden={isMobileDrawer && !isAiPanelOpen ? true : undefined}
        aria-labelledby="ai-panel-title"
        aria-modal={isMobileDrawer && isAiPanelOpen ? true : undefined}
        className="ai-panel fixed inset-y-0 right-0 z-20 flex flex-col border-l border-neutral-200 bg-white shadow-2xl shadow-neutral-950/15"
        data-drawer-state={isAiPanelOpen ? "open" : "closed"}
        data-testid="ai-panel"
        id="ai-panel"
        role={isMobileDrawer ? "dialog" : "complementary"}
        {...(isMobileDrawer && !isAiPanelOpen ? { inert: "" } : {})}
      >
        <div className="border-b border-neutral-200 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-neutral-500">
              <Sparkles className="size-4 text-blue-600" aria-hidden="true" />
              AI 图像工作台
            </div>
            <div className="flex items-center gap-2">
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
                aria-label="关闭 AI 生成面板"
                className="ai-panel-close"
                ref={panelCloseButtonRef}
                type="button"
                onClick={closeAiPanel}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
          <h1 className="mt-1 text-xl font-semibold text-neutral-950" id="ai-panel-title">
            图像生成
          </h1>
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
                提示词生成
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
                参考生成
              </button>
            </div>
          </div>

          <label className="block">
            <span className="control-label">提示词</span>
            <textarea
              className="mt-2 h-32 w-full resize-none rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm leading-6 text-neutral-950 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
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

          {panelStatus ? (
            <div
              aria-live={panelStatus.tone === "progress" ? "polite" : "assertive"}
              className={`panel-status-strip ${panelStatusStyles[panelStatus.tone]}`}
              data-testid={panelStatus.testId}
              role={panelStatus.tone === "success" || panelStatus.tone === "progress" ? "status" : "alert"}
            >
              <PanelStatusIcon tone={panelStatus.tone} />
              <p className="min-w-0 flex-1">{panelStatus.message}</p>
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
                  <p className="text-sm font-semibold">{isReferenceReady ? "参考生成已就绪" : "请选择一张参考图"}</p>
                  <p className="mt-1 text-xs leading-5" data-testid="reference-hint">
                    {referenceSelection.hint}
                  </p>
                  {referenceSelection.status === "ready" ? (
                    <div className="mt-3 flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-xs font-medium" data-testid="reference-name">
                        {referenceSelection.name} · {Math.round(referenceSelection.width)} x {Math.round(referenceSelection.height)}
                      </p>
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

          <label className="block">
            <span className="control-label">尺寸</span>
            <select
              className="field-control"
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

          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="control-label">宽度</span>
              <input
                className="field-control"
                min={MIN_IMAGE_DIMENSION}
                max={MAX_IMAGE_DIMENSION}
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
                min={MIN_IMAGE_DIMENSION}
                max={MAX_IMAGE_DIMENSION}
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
              {GENERATION_COUNTS.map((item) => (
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
          <button
            className="primary-action"
            disabled={!canGenerate}
            type="button"
            data-generation-mode={generationMode}
            data-reference-mode={isReferenceReady ? "edit" : "generate"}
            data-testid="generate-button"
            onClick={submitGeneration}
          >
            {isReferenceReady ? (
              <ImageIcon className="size-4" aria-hidden="true" />
            ) : (
              <Square className="size-4" aria-hidden="true" />
            )}
            {generationMode === "reference" ? "参考生成" : "提示词生成"}
          </button>
        </div>
      </aside>
    </main>
  );
}
