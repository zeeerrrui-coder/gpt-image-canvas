import OpenAI from "openai";
import type { LocalOpenAIProfileRecord } from "./provider-config.js";

export interface ProviderTestOutcome {
  ok: boolean;
  message: string;
}

export interface ProviderModelListOutcome {
  ok: true;
  models: string[];
}

const TEST_TIMEOUT_MS = 15_000;

export async function testLocalProfileConnection(profile: LocalOpenAIProfileRecord): Promise<ProviderTestOutcome> {
  try {
    const client = createClient(profile);
    const models = await client.models.list();
    if (!models?.data || models.data.length === 0) {
      return { ok: true, message: "连接成功，但服务端没有返回任何模型。" };
    }
    return { ok: true, message: `连接成功，可用模型 ${models.data.length} 个。` };
  } catch (error) {
    return { ok: false, message: connectionErrorMessage(error) };
  }
}

export async function listLocalProfileModels(profile: LocalOpenAIProfileRecord): Promise<string[]> {
  const client = createClient(profile);
  const response = await client.models.list();
  if (!response?.data) {
    return [];
  }

  const ids = response.data
    .map((model) => (typeof model.id === "string" ? model.id : ""))
    .filter((id) => id.length > 0);

  return Array.from(new Set(ids)).sort();
}

function createClient(profile: LocalOpenAIProfileRecord): OpenAI {
  return new OpenAI({
    apiKey: profile.apiKey,
    baseURL: profile.baseUrl?.trim() || undefined,
    timeout: TEST_TIMEOUT_MS
  });
}

function connectionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return sanitize(error.message);
  }
  return "连接失败，请检查 API Key、Base URL 和模型名。";
}

function sanitize(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "sk-[redacted]")
    .trim()
    .slice(0, 400);
}
