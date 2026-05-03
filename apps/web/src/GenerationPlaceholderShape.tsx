import { BaseBoxShapeUtil, HTMLContainer, RecordProps, T, TLShape } from "tldraw";
import { useI18n } from "./i18n";

export const GENERATION_PLACEHOLDER_TYPE = "generation-placeholder" as const;

export type GenerationPlaceholderStatus = "loading" | "failed";

interface GenerationPlaceholderProps {
  w: number;
  h: number;
  targetWidth: number;
  targetHeight: number;
  status: GenerationPlaceholderStatus;
  error: string;
  requestId: string;
  outputIndex: number;
}

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    [GENERATION_PLACEHOLDER_TYPE]: GenerationPlaceholderProps;
  }
}

export type GenerationPlaceholderShape = TLShape<typeof GENERATION_PLACEHOLDER_TYPE>;

function conciseError(message: string, fallback: string): string {
  const trimmed = message.trim() || fallback;
  return trimmed.length > 46 ? `${trimmed.slice(0, 46)}...` : trimmed;
}

function GenerationPlaceholderContent({ shape }: { shape: GenerationPlaceholderShape }) {
  const { t } = useI18n();
  const isFailed = shape.props.status === "failed";

  return (
    <HTMLContainer
      className={`generation-placeholder-shape ${isFailed ? "is-failed" : "is-loading"}`}
      data-generation-placeholder-status={shape.props.status}
    >
      <div className="generation-placeholder-shape__content">
        {isFailed ? (
          <div className="generation-placeholder-shape__error-mark" aria-hidden="true">
            !
          </div>
        ) : (
          <div className="generation-placeholder-shape__spinner" aria-hidden="true" />
        )}
        <div className="generation-placeholder-shape__title">{isFailed ? t("generationCanvasFailed") : t("generationCanvasLoading")}</div>
        <div className="generation-placeholder-shape__size">
          {shape.props.targetWidth} x {shape.props.targetHeight}px
        </div>
        <div className="generation-placeholder-shape__copy">
          {isFailed ? conciseError(shape.props.error, t("generationErrorDefault")) : "gpt-image-canvas"}
        </div>
      </div>
    </HTMLContainer>
  );
}

export class GenerationPlaceholderShapeUtil extends BaseBoxShapeUtil<GenerationPlaceholderShape> {
  static override type = GENERATION_PLACEHOLDER_TYPE;
  static override props: RecordProps<GenerationPlaceholderShape> = {
    w: T.number,
    h: T.number,
    targetWidth: T.number,
    targetHeight: T.number,
    status: T.literalEnum("loading", "failed"),
    error: T.string,
    requestId: T.string,
    outputIndex: T.number
  };

  override canBind(): boolean {
    return false;
  }

  override canResize(): boolean {
    return false;
  }

  override isAspectRatioLocked(): boolean {
    return true;
  }

  override getDefaultProps(): GenerationPlaceholderShape["props"] {
    return {
      w: 300,
      h: 300,
      targetWidth: 1024,
      targetHeight: 1024,
      status: "loading",
      error: "",
      requestId: "",
      outputIndex: 0
    };
  }

  override component(shape: GenerationPlaceholderShape) {
    return <GenerationPlaceholderContent shape={shape} />;
  }

  override indicator(shape: GenerationPlaceholderShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} ry={8} />;
  }
}
