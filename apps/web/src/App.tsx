import {
  ChevronDown,
  Loader2,
  Sparkles,
  Square,
  XCircle
} from "lucide-react";
import { useMemo, useState } from "react";
import { Tldraw } from "tldraw";
import {
  GENERATION_COUNTS,
  IMAGE_QUALITIES,
  MAX_IMAGE_DIMENSION,
  MIN_IMAGE_DIMENSION,
  OUTPUT_FORMATS,
  SIZE_PRESETS,
  STYLE_PRESETS,
  validateImageSize,
  type GenerationCount,
  type ImageQuality,
  type OutputFormat,
  type SizePreset,
  type StylePresetId
} from "@gpt-image-canvas/shared";

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

  return `宽高必须是 ${MIN_IMAGE_DIMENSION}-${MAX_IMAGE_DIMENSION}px 内的整数，且总像素不超过 4096 x 4096。`;
}

export function App() {
  const [prompt, setPrompt] = useState("");
  const [stylePreset, setStylePreset] = useState<StylePresetId>("none");
  const [sizePresetId, setSizePresetId] = useState(SIZE_PRESETS[0].id);
  const [width, setWidth] = useState(SIZE_PRESETS[0].width);
  const [height, setHeight] = useState(SIZE_PRESETS[0].height);
  const [count, setCount] = useState<GenerationCount>(1);
  const [quality, setQuality] = useState<ImageQuality>("auto");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("png");
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const trimmedPrompt = prompt.trim();
  const promptValidationMessage = trimmedPrompt ? "" : "请输入提示词后再生成。";
  const dimensionValidationMessage = sizeValidationMessage(width, height);
  const validationMessage = promptValidationMessage || dimensionValidationMessage;
  const canGenerate = !validationMessage && !isGenerating;

  const activePreset = useMemo(
    () => SIZE_PRESETS.find((preset) => preset.id === sizePresetId) ?? SIZE_PRESETS[0],
    [sizePresetId]
  );

  function selectScenePreset(nextPresetId: string): void {
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
  }

  function updateHeight(value: string): void {
    setHeight(normalizeDimension(value));
  }

  function submitGeneration(): void {
    setHasSubmitted(true);

    if (validationMessage) {
      return;
    }

    setIsGenerating(true);
  }

  function cancelGeneration(): void {
    setIsGenerating(false);
  }

  const shouldShowValidation = hasSubmitted || !trimmedPrompt || Boolean(dimensionValidationMessage);

  return (
    <main className="relative flex h-dvh min-h-[640px] overflow-hidden bg-neutral-950 pr-[380px] text-neutral-900">
      <section
        className="relative min-w-0 flex-1 bg-neutral-100"
        aria-label="tldraw 创作画布"
        data-testid="canvas-shell"
      >
        <Tldraw />
      </section>

      <aside
        className="fixed inset-y-0 right-0 z-20 flex w-[380px] flex-col border-l border-neutral-200 bg-white shadow-2xl shadow-neutral-950/15"
        data-testid="ai-panel"
      >
        <div className="border-b border-neutral-200 px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-medium text-neutral-500">
            <Sparkles className="size-4 text-blue-600" aria-hidden="true" />
            AI 图像工作台
          </div>
          <h1 className="mt-1 text-xl font-semibold text-neutral-950">专业画布生成</h1>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
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

          {shouldShowValidation && validationMessage ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700" data-testid="validation-message">
              {validationMessage}
            </p>
          ) : null}

          <label className="block">
            <span className="control-label">风格预设</span>
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
            <span className="control-label">场景尺寸</span>
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

          <div className="rounded-md bg-neutral-100 px-3 py-3 text-xs leading-5 text-neutral-600">
            当前尺寸：{sizePresetLabel(activePreset)}，画布输出 {Number.isNaN(width) ? "-" : width} x{" "}
            {Number.isNaN(height) ? "-" : height}px
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-3 border-t border-neutral-200 bg-white px-5 py-4">
          <button
            className="primary-action"
            disabled={!canGenerate}
            type="button"
            data-testid="generate-button"
            onClick={submitGeneration}
          >
            {isGenerating ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Square className="size-4" aria-hidden="true" />}
            生成
          </button>
          <button className="secondary-action" disabled={!isGenerating} type="button" onClick={cancelGeneration}>
            <XCircle className="size-4" aria-hidden="true" />
            取消
          </button>
        </div>
      </aside>
    </main>
  );
}
