import OpenAI, { APIConnectionTimeoutError, APIError, APIUserAbortError, toFile } from "openai";
import type { ImageEditParamsNonStreaming, ImageGenerateParamsNonStreaming, ImagesResponse } from "openai/resources/images";
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
  b64Json: string;
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

export interface OpenAIImageProviderConfig {
  apiKey: string;
  baseURL?: string;
  timeoutMs: number;
}

const DEFAULT_OPENAI_IMAGE_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const SUPPORTED_REFERENCE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

type FlexibleImageGenerateParams = Omit<ImageGenerateParamsNonStreaming, "size"> & {
  size: string;
};

type FlexibleImageEditParams = Omit<ImageEditParamsNonStreaming, "size"> & {
  size: string;
};

export function getOpenAIImageProviderConfig():
  | {
      ok: true;
      config: OpenAIImageProviderConfig;
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

  const baseURL = process.env.OPENAI_BASE_URL?.trim();

  return {
    ok: true,
    config: {
      apiKey,
      baseURL: baseURL || undefined,
      timeoutMs: parsePositiveInteger(process.env.OPENAI_IMAGE_TIMEOUT_MS, DEFAULT_OPENAI_IMAGE_TIMEOUT_MS)
    }
  };
}

export function createOpenAIImageProvider(config: OpenAIImageProviderConfig): ImageProvider {
  return new OpenAIImageProvider(config);
}

class OpenAIImageProvider implements ImageProvider {
  private readonly client: OpenAI;

  constructor(config: OpenAIImageProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeoutMs
    });
  }

  async generate(input: ImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    try {
      const response = await this.client.images.generate(
        imageGenerateRequestBody({
          model: IMAGE_MODEL,
          prompt: input.prompt,
          size: input.sizeApiValue,
          quality: input.quality,
          output_format: input.outputFormat,
          n: input.count
        }),
        { signal }
      );

      return normalizeProviderResponse(response, input.sizeApiValue);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async edit(input: EditImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    try {
      const reference = await dataUrlToFile(input.referenceImage);
      const response = await this.client.images.edit(
        imageEditRequestBody({
          model: IMAGE_MODEL,
          image: [reference],
          prompt: input.prompt,
          size: input.sizeApiValue,
          quality: input.quality,
          output_format: input.outputFormat,
          n: input.count
        }),
        { signal }
      );

      return normalizeProviderResponse(response, input.sizeApiValue);
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

function imageGenerateRequestBody(body: FlexibleImageGenerateParams): ImageGenerateParamsNonStreaming {
  // The SDK's image size union can lag gpt-image-2's documented flexible-size support.
  return body as unknown as ImageGenerateParamsNonStreaming;
}

function imageEditRequestBody(body: FlexibleImageEditParams): ImageEditParamsNonStreaming {
  // The SDK's image size union can lag gpt-image-2's documented flexible-size support.
  return body as unknown as ImageEditParamsNonStreaming;
}

function toProviderError(error: unknown): Error {
  if (isAbortError(error)) {
    return error;
  }

  if (error instanceof ProviderError) {
    return error;
  }

  if (error instanceof APIConnectionTimeoutError) {
    return new ProviderError("upstream_failure", "OpenAI 图像服务请求超时，请稍后重试或降低分辨率。", 504);
  }

  if (error instanceof APIError) {
    return new ProviderError("upstream_failure", error.message || "OpenAI 图像服务请求失败。", providerHttpStatus(error.status));
  }

  if (error instanceof Error && error.message) {
    return new ProviderError("upstream_failure", error.message, 502);
  }

  return new ProviderError("upstream_failure", "OpenAI 图像服务请求失败。", 502);
}

function providerHttpStatus(status: number | undefined): number {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof APIUserAbortError || (error instanceof DOMException && error.name === "AbortError");
}

function normalizeProviderResponse(response: ImagesResponse, sizeApiValue: string): ProviderResult {
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像服务没有返回图像结果。", 502);
  }

  const images = response.data.map((item) => ({
    b64Json: typeof item.b64_json === "string" ? item.b64_json : ""
  }));

  if (images.some((image) => !image.b64Json)) {
    throw new ProviderError("unsupported_provider_behavior", "OpenAI 图像服务没有返回 base64 图像数据。", 502);
  }

  return {
    model: IMAGE_MODEL,
    size: sizeApiValue,
    images
  };
}

async function dataUrlToFile(input: ReferenceImageInput): Promise<File> {
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

  const normalizedMimeType = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
  const extension = normalizedMimeType === "image/jpeg" ? "jpg" : normalizedMimeType.split("/")[1] || "png";
  const fileName = sanitizeFileName(input.fileName) ?? `reference.${extension}`;
  return toFile(bytes, fileName, { type: normalizedMimeType });
}

function sanitizeFileName(fileName: string | undefined): string | undefined {
  const trimmed = fileName?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]/gu, "_");
}
