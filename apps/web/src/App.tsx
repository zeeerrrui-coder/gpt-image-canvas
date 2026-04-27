import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Loader2,
  Sparkles,
  Square,
  XCircle
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tldraw, type Editor, type TLEditorSnapshot, type TLStoreSnapshot } from "tldraw";
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
  type ProjectState,
  type SizePreset,
  type StylePresetId
} from "@gpt-image-canvas/shared";

const AUTOSAVE_DEBOUNCE_MS = 1200;

type PersistedSnapshot = TLEditorSnapshot | TLStoreSnapshot;
type SaveStatus = "loading" | "saved" | "pending" | "saving" | "error";

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

  return result.message;
}

function isPersistedSnapshot(value: unknown): value is PersistedSnapshot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const [isProjectLoaded, setIsProjectLoaded] = useState(false);
  const [projectSnapshot, setProjectSnapshot] = useState<PersistedSnapshot | undefined>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading");
  const [saveError, setSaveError] = useState("");
  const saveTimerRef = useRef<number | undefined>();
  const saveRequestRef = useRef(0);

  const trimmedPrompt = prompt.trim();
  const promptValidationMessage = trimmedPrompt ? "" : "请输入提示词后再生成。";
  const dimensionValidationMessage = sizeValidationMessage(width, height);
  const validationMessage = promptValidationMessage || dimensionValidationMessage;
  const canGenerate = !validationMessage && !isGenerating;

  const activePreset = useMemo(
    () => SIZE_PRESETS.find((preset) => preset.id === sizePresetId) ?? SIZE_PRESETS[0],
    [sizePresetId]
  );

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
        if (isPersistedSnapshot(project.snapshot)) {
          setProjectSnapshot(project.snapshot);
        }
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

  const handleEditorMount = useCallback((editor: Editor) => {
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
            snapshot: editor.getSnapshot()
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
        setSaveStatus("pending");
        setSaveError("");
        saveTimerRef.current = window.setTimeout(() => {
          void saveProject();
        }, AUTOSAVE_DEBOUNCE_MS);
      },
      {
        source: "user",
        scope: "document"
      }
    );

    return () => {
      window.clearTimeout(saveTimerRef.current);
      removeListener();
    };
  }, []);

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
        {isProjectLoaded ? (
          <Tldraw snapshot={projectSnapshot} onMount={handleEditorMount} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">正在载入画布...</div>
        )}
      </section>

      <aside
        className="fixed inset-y-0 right-0 z-20 flex w-[380px] flex-col border-l border-neutral-200 bg-white shadow-2xl shadow-neutral-950/15"
        data-testid="ai-panel"
      >
        <div className="border-b border-neutral-200 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-neutral-500">
              <Sparkles className="size-4 text-blue-600" aria-hidden="true" />
              AI 图像工作台
            </div>
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
          </div>
          <h1 className="mt-1 text-xl font-semibold text-neutral-950">专业画布生成</h1>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          {saveError ? (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="save-error">
              {saveError}
            </p>
          ) : null}

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
