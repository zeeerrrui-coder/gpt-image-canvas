import {
  IMAGE_MODEL,
  type ImageQuality,
  type ImageSize,
  type OutputFormat,
  type ReferenceImageInput
} from "./contracts.js";

export interface ImageProviderInput {
  originalPrompt: string;
  presetId: string;
  prompt: string;
  size: ImageSize;
  sizeApiValue: string;
  quality: ImageQuality;
  outputFormat: OutputFormat;
  count: number;
}

export interface EditImageProviderInput extends ImageProviderInput {
  referenceImage: ReferenceImageInput;
  referenceAssetId?: string;
}

export interface ProviderImage {
  b64Json?: string;
  url?: string;
  revisedPrompt?: string;
}

export interface ProviderResult {
  model: typeof IMAGE_MODEL;
  size: string;
  images: ProviderImage[];
}

export interface ImageProvider {
  generate(input: ImageProviderInput, signal?: AbortSignal): Promise<ProviderResult>;
  edit(input: EditImageProviderInput, signal?: AbortSignal): Promise<ProviderResult>;
}

export type ProviderErrorCode = "missing_api_key" | "unsupported_provider_behavior" | "upstream_failure";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface OpenAICompatibleProviderConfig {
  apiKey: string;
  baseUrl: string;
}

interface OpenAIImageResponse {
  data?: Array<{
    b64_json?: unknown;
    url?: unknown;
    revised_prompt?: unknown;
  }>;
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

export function getOpenAICompatibleProviderConfig():
  | {
      ok: true;
      config: OpenAICompatibleProviderConfig;
    }
  | {
      ok: false;
      error: ProviderError;
    } {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      error: new ProviderError("missing_api_key", "服务器缺少 OPENAI_API_KEY，无法生成图像。", 500)
    };
  }

  return {
    ok: true,
    config: {
      apiKey,
      baseUrl: normalizeBaseUrl(process.env.OPENAI_BASE_URL)
    }
  };
}

export function createOpenAICompatibleImageProvider(config: OpenAICompatibleProviderConfig): ImageProvider {
  return new OpenAICompatibleImageProvider(config);
}

class OpenAICompatibleImageProvider implements ImageProvider {
  constructor(private readonly config: OpenAICompatibleProviderConfig) {}

  async generate(input: ImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    const response = await this.postJson("/images/generations", {
      model: IMAGE_MODEL,
      prompt: input.prompt,
      size: input.sizeApiValue,
      quality: input.quality,
      output_format: input.outputFormat,
      n: input.count
    }, signal);

    return normalizeProviderResponse(response, input.sizeApiValue);
  }

  async edit(input: EditImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    const form = new FormData();
    const reference = dataUrlToBlob(input.referenceImage.dataUrl);

    form.set("model", IMAGE_MODEL);
    form.set("prompt", input.prompt);
    form.set("size", input.sizeApiValue);
    form.set("quality", input.quality);
    form.set("output_format", input.outputFormat);
    form.set("n", String(input.count));
    form.set("image", reference.blob, input.referenceImage.fileName ?? `reference.${reference.extension}`);

    const response = await this.postForm("/images/edits", form, signal);
    return normalizeProviderResponse(response, input.sizeApiValue);
  }

  private async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<OpenAIImageResponse> {
    return this.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal
    });
  }

  private async postForm(path: string, body: FormData, signal?: AbortSignal): Promise<OpenAIImageResponse> {
    return this.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body,
      signal
    });
  }

  private async request(path: string, init: RequestInit): Promise<OpenAIImageResponse> {
    let response: Response;

    try {
      response = await fetch(`${this.config.baseUrl}${path}`, init);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ProviderError("upstream_failure", "上游图像服务请求失败，请稍后重试。", 502);
    }

    if (!response.ok) {
      throw new ProviderError("upstream_failure", `上游图像服务返回失败状态 ${response.status}。`, 502);
    }

    try {
      return (await response.json()) as OpenAIImageResponse;
    } catch {
      throw new ProviderError("unsupported_provider_behavior", "上游图像服务返回了无法解析的响应。", 502);
    }
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function normalizeProviderResponse(response: OpenAIImageResponse, sizeApiValue: string): ProviderResult {
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new ProviderError("unsupported_provider_behavior", "上游图像服务没有返回图像结果。", 502);
  }

  const images = response.data.map((item) => ({
    b64Json: typeof item.b64_json === "string" ? item.b64_json : undefined,
    url: typeof item.url === "string" ? item.url : undefined,
    revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined
  }));

  if (images.some((image) => !image.b64Json && !image.url)) {
    throw new ProviderError("unsupported_provider_behavior", "上游图像服务返回了不支持的图像结果。", 502);
  }

  return {
    model: IMAGE_MODEL,
    size: sizeApiValue,
    images
  };
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; extension: string } {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像格式不受支持。", 400);
  }

  const mimeType = match[1];
  const extension = mimeType.split("/")[1] || "png";
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new ProviderError("unsupported_provider_behavior", "参考图像不能超过 20MB。", 400);
  }

  return {
    blob: new Blob([bytes], { type: mimeType }),
    extension
  };
}
