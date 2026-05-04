import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./database.js";
import { imageGenerationJobs } from "./schema.js";
import { refundGenerationCredits, reserveGenerationCredits } from "./credit-service.js";
import {
  ProviderError,
  type EditImageProviderInput,
  type ImageProviderInput
} from "./image-provider.js";
import { runReferenceImageGeneration, runTextToImageGeneration } from "./image-generation.js";
import { createConfiguredImageProvider } from "./image-provider-selection.js";
import { recordErrorLog } from "./admin-stats-service.js";
import { creditCostForSize, type CreditCostConfig, type GenerationRecord, type ImageMode } from "./contracts.js";

export type ImageJobStatus = "pending" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

export interface ImageJobView {
  id: string;
  mode: ImageMode;
  status: ImageJobStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  record: GenerationRecord | null;
}

const activeAbortControllers = new Map<string, AbortController>();

export function createImageJob(input: {
  userId: string;
  mode: "generate";
  payload: ImageProviderInput;
  creditCosts: CreditCostConfig;
}): { jobId: string; reservedAmount: number };
export function createImageJob(input: {
  userId: string;
  mode: "edit";
  payload: EditImageProviderInput;
  creditCosts: CreditCostConfig;
}): { jobId: string; reservedAmount: number };
export function createImageJob(input: {
  userId: string;
  mode: ImageMode;
  payload: ImageProviderInput | EditImageProviderInput;
  creditCosts: CreditCostConfig;
}): { jobId: string; reservedAmount: number } {
  const creditPerImage = creditCostForSize(input.payload.size, input.creditCosts);
  const reservedAmount = creditPerImage * input.payload.count;

  reserveGenerationCredits({
    userId: input.userId,
    requestedCount: input.payload.count,
    creditPerImage
  });

  const jobId = randomUUID();
  const now = new Date().toISOString();

  try {
    db.insert(imageGenerationJobs)
      .values({
        id: jobId,
        userId: input.userId,
        mode: input.mode,
        status: "pending",
        inputJson: JSON.stringify(input.payload),
        reservedAmount,
        creditPerImage,
        generationRecordId: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now
      })
      .run();
  } catch (error) {
    refundGenerationCredits({ userId: input.userId, amount: reservedAmount });
    throw error;
  }

  return { jobId, reservedAmount };
}

export function startImageJob(jobId: string, userId: string): void {
  const controller = new AbortController();
  activeAbortControllers.set(jobId, controller);

  void runJob(jobId, userId, controller.signal).finally(() => {
    activeAbortControllers.delete(jobId);
  });
}

async function runJob(jobId: string, userId: string, signal: AbortSignal): Promise<void> {
  const job = db.select().from(imageGenerationJobs).where(eq(imageGenerationJobs.id, jobId)).get();
  if (!job || job.userId !== userId) {
    return;
  }

  updateJobStatus(jobId, "running");

  try {
    if (signal.aborted) {
      throw new DOMException("Aborted before start.", "AbortError");
    }

    const provider = await createConfiguredImageProvider(signal);
    const payload = JSON.parse(job.inputJson) as ImageProviderInput | EditImageProviderInput;

    const result =
      job.mode === "edit"
        ? await runReferenceImageGeneration(payload as EditImageProviderInput, provider, userId, signal)
        : await runTextToImageGeneration(payload as ImageProviderInput, provider, userId, signal);

    const successfulCount = result.record.outputs.filter((output) => output.status === "succeeded" && output.asset).length;
    const refundAmount = (payload.count - successfulCount) * job.creditPerImage;

    const finished = finishActiveJob(jobId, {
      status: result.record.status === "succeeded" ? "succeeded" : result.record.status === "partial" ? "partial" : "failed",
      generationRecordId: result.record.id,
      errorCode: result.record.error ? "generation_error" : null,
      errorMessage: result.record.error ?? null
    });
    if (finished && refundAmount > 0) {
      safeRefund(userId, refundAmount, result.record.id);
    }
  } catch (error) {
    const aborted = signal.aborted || isAbortError(error);
    const finished = finishActiveJob(jobId, {
      status: aborted ? "cancelled" : "failed",
      generationRecordId: null,
      errorCode: error instanceof ProviderError ? error.code : aborted ? "cancelled" : "internal_error",
      errorMessage: errorMessage(error)
    });
    if (finished) {
      safeRefund(userId, job.reservedAmount);
    }
  }
}

export function cancelImageJob(jobId: string, userId: string): boolean {
  const job = db.select().from(imageGenerationJobs).where(eq(imageGenerationJobs.id, jobId)).get();
  if (!job || job.userId !== userId) {
    return false;
  }
  if (job.status !== "pending" && job.status !== "running") {
    return false;
  }

  const controller = activeAbortControllers.get(jobId);
  if (controller) {
    controller.abort();
    return true;
  }

  // 防御兜底：理论不可达（cancelImageJob 全程同步、worker 的 finally 在 finishJob 之后才删 Map），
  // 但保留以防未来重构破坏不变量。仍走 finishActiveJob 幂等通道。
  const finished = finishActiveJob(jobId, {
    status: "cancelled",
    generationRecordId: null,
    errorCode: "cancelled",
    errorMessage: "用户取消。"
  });
  if (finished) {
    safeRefund(userId, job.reservedAmount);
  }
  return true;
}

export function getImageJobView(jobId: string, userId: string, recordResolver: (id: string) => GenerationRecord | null): ImageJobView | undefined {
  const job = db.select().from(imageGenerationJobs).where(eq(imageGenerationJobs.id, jobId)).get();
  if (!job || job.userId !== userId) {
    return undefined;
  }
  return toJobView(job, recordResolver);
}

export function listRecentImageJobs(userId: string, limit = 50, recordResolver: (id: string) => GenerationRecord | null): ImageJobView[] {
  const jobs = db
    .select()
    .from(imageGenerationJobs)
    .where(eq(imageGenerationJobs.userId, userId))
    .orderBy(desc(imageGenerationJobs.createdAt))
    .limit(limit)
    .all();
  return jobs.map((job) => toJobView(job, recordResolver));
}

export function recoverInterruptedJobs(): number {
  const stuck = db
    .select()
    .from(imageGenerationJobs)
    .where(inArray(imageGenerationJobs.status, ["pending", "running"]))
    .all();

  let recovered = 0;
  for (const job of stuck) {
    const finished = finishActiveJob(job.id, {
      status: "failed",
      generationRecordId: null,
      errorCode: "interrupted",
      errorMessage: "服务重启时该任务被中断。"
    });
    if (finished) {
      safeRefund(job.userId, job.reservedAmount);
      recovered += 1;
    }
  }
  return recovered;
}

function updateJobStatus(jobId: string, status: ImageJobStatus): void {
  const now = new Date().toISOString();
  db.update(imageGenerationJobs).set({ status, updatedAt: now }).where(eq(imageGenerationJobs.id, jobId)).run();
}

function finishActiveJob(jobId: string, input: { status: ImageJobStatus; generationRecordId: string | null; errorCode: string | null; errorMessage: string | null }): boolean {
  const now = new Date().toISOString();
  const result = db
    .update(imageGenerationJobs)
    .set({
      status: input.status,
      generationRecordId: input.generationRecordId,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      updatedAt: now
    })
    .where(and(eq(imageGenerationJobs.id, jobId), inArray(imageGenerationJobs.status, ["pending", "running"])))
    .run();
  return result.changes > 0;
}

function toJobView(job: typeof imageGenerationJobs.$inferSelect, recordResolver: (id: string) => GenerationRecord | null): ImageJobView {
  return {
    id: job.id,
    mode: job.mode as ImageMode,
    status: job.status as ImageJobStatus,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    record: job.generationRecordId ? recordResolver(job.generationRecordId) : null
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 800);
  }
  return "Unknown error.";
}

function safeRefund(userId: string, amount: number, generationId?: string): void {
  if (amount <= 0) {
    return;
  }
  try {
    refundGenerationCredits({ userId, amount, ...(generationId ? { generationId } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("refund failed:", message);
    recordErrorLog({
      path: "image-job-service.refund",
      method: "INTERNAL",
      status: 500,
      code: "refund_failed",
      message: `userId=${userId} amount=${amount}: ${message}`,
      userId
    });
  }
}

