import type { CodexAccessSession } from "./codex-auth.js";
import type {
  EditImageProviderInput,
  ImageProvider,
  ImageProviderInput,
  ProviderResult
} from "./image-provider.js";
import { ProviderError, getConfiguredImageModel } from "./image-provider.js";
import type { ReferenceImageInput } from "./contracts.js";

const DEFAULT_CODEX_IMAGE_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const SUPPORTED_REFERENCE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export interface CodexImageProviderConfig {
  baseURL: string;
  model: string;
  timeoutMs: number;
  getSession: (signal?: AbortSignal) => Promise<CodexAccessSession | undefined>;
}

type ResponsesImageInput = ImageProviderInput | EditImageProviderInput;

interface ResponsesImageTool {
  type: "image_generation";
  size: string;
  quality: string;
  format: string;
}

export function getCodexImageProviderTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.CODEX_IMAGE_TIMEOUT_MS ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CODEX_IMAGE_TIMEOUT_MS;
}

export function createCodexImageProvider(config: CodexImageProviderConfig): ImageProvider {
  return new CodexResponsesImageProvider(config);
}

export function createCodexResponsesRequestBody(input: ResponsesImageInput): Record<string, unknown> {
  const tool: ResponsesImageTool = {
    type: "image_generation",
    size: input.sizeApiValue,
    quality: input.quality,
    format: input.outputFormat
  };

  return {
    model: getConfiguredImageModel(),
    input: [
      {
        role: "user",
        content: createResponsesInputContent(input)
      }
    ],
    tools: [tool],
    tool_choice: {
      type: "image_generation"
    },
    stream: true
  };
}

export function parseCodexResponsesEventsFromSse(text: string): unknown[] {
  const events: unknown[] = [];
  let dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length === 0) {
      return;
    }

    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") {
      return;
    }

    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      events.push(data);
    }
  };

  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) {
      flush();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  flush();
  return events;
}

export function extractCodexImageBase64FromResponseEvents(events: unknown[]): string[] {
  const images: string[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    for (const image of extractCodexImageBase64FromResponseEvent(event)) {
      if (!seen.has(image)) {
        seen.add(image);
        images.push(image);
      }
    }
  }

  return images;
}

export function extractCodexImageBase64FromResponseEvent(event: unknown): string[] {
  const record = objectValue(event);
  if (!record) {
    return [];
  }

  if (record.type === "response.output_item.done") {
    return extractImagesFromOutputItem(record.item ?? record.output_item);
  }

  if (record.type === "response.completed") {
    return extractImagesFromResponse(record.response);
  }

  return [...extractImagesFromResponse(record), ...extractImagesFromOutputItem(record)];
}

class CodexResponsesImageProvider implements ImageProvider {
  constructor(private readonly config: CodexImageProviderConfig) {}

  async generate(input: ImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    return this.requestImage(input, signal);
  }

  async edit(input: EditImageProviderInput, signal?: AbortSignal): Promise<ProviderResult> {
    return this.requestImage(input, signal);
  }

  private async requestImage(input: ResponsesImageInput, signal?: AbortSignal): Promise<ProviderResult> {
    const session = await this.config.getSession(signal);
    if (!session) {
      throw new ProviderError(
        "missing_provider",
        "服务器没有配置 OPENAI_API_KEY，也没有可用的 Codex 登录会话。请先登录 Codex 后重试。",
        401
      );
    }

    const timeout = timeoutSignal(signal, this.config.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseURL.replace(/\/+$/u, "")}/responses`, {
        method: "POST",
        headers: codexRequestHeaders(session),
        body: JSON.stringify({
          ...createCodexResponsesRequestBody(input),
          model: this.config.model
        }),
        signal: timeout.signal
      }).catch((error: unknown) => {
        throw fetchFailureToProviderError(error);
      });

      if (!response.ok) {
        throw codexHttpProviderError(response.status);
      }

      const events = await readCodexResponseEvents(response);
      const images = extractCodexImageBase64FromResponseEvents(events);
      if (images.length === 0) {
        throw new ProviderError("unsupported_provider_behavior", "Codex 图像服务没有返回图像结果。", 502);
      }

      return {
        model: this.config.model,
        size: input.sizeApiValue,
        images: images.map((image) => ({
          b64Json: image
        }))
      };
    } finally {
      timeout.cleanup();
    }
  }
}

async function readCodexResponseEvents(response: Response): Promise<unknown[]> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = await response.json().catch(() => undefined);
    return json === undefined ? [] : [json];
  }

  return parseCodexResponsesEventsFromSse(await response.text());
}

function createResponsesInputContent(input: ResponsesImageInput): Array<Record<string, string>> {
  const content: Array<Record<string, string>> = [
    {
      type: "input_text",
      text: input.prompt
    }
  ];

  if ("referenceImage" in input) {
    content.push({
      type: "input_image",
      image_url: normalizeReferenceImageDataUrl(input.referenceImage)
    });
  }

  return content;
}

function normalizeReferenceImageDataUrl(input: ReferenceImageInput): string {
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
  return `data:${normalizedMimeType};base64,${match[2]}`;
}

function codexRequestHeaders(session: CodexAccessSession): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json"
  };

  if (session.accountId) {
    headers["ChatGPT-Account-ID"] = session.accountId;
  }

  return headers;
}

function extractImagesFromResponse(response: unknown): string[] {
  const record = objectValue(response);
  if (!record || !Array.isArray(record.output)) {
    return [];
  }

  return record.output.flatMap(extractImagesFromOutputItem);
}

function extractImagesFromOutputItem(item: unknown): string[] {
  const record = objectValue(item);
  if (!record || record.type !== "image_generation_call") {
    return [];
  }

  const image = normalizeImageBase64(record.result);
  return image ? [image] : [];
}

function normalizeImageBase64(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  const dataUrlMatch = /^data:image\/[^;,]+;base64,(.+)$/u.exec(trimmed);
  return dataUrlMatch?.[1] ?? trimmed;
}

function codexHttpProviderError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError("upstream_failure", "Codex 图像服务认证失败，请重新登录 Codex。", status);
  }

  return new ProviderError("upstream_failure", `Codex 图像服务请求失败（HTTP ${status}）。`, providerHttpStatus(status));
}

function fetchFailureToProviderError(error: unknown): ProviderError | Error {
  if (isAbortError(error)) {
    return new ProviderError("upstream_failure", "Codex 图像服务请求超时，请稍后重试或降低分辨率。", 504);
  }

  return new ProviderError("upstream_failure", "Codex 图像服务请求失败，请稍后重试。", 502);
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);

  if (signal?.aborted) {
    abort();
  } else if (signal) {
    signal.addEventListener("abort", abort, { once: true });
  }

  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}

function providerHttpStatus(status: number | undefined): number {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof DOMException && error.name === "AbortError";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
