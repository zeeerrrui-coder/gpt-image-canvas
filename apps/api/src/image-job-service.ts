import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
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
  queuePositionApprox?: number | null;
}

const MAX_CONCURRENT_IMAGE_JOBS = parsePositiveEnvInt(process.env.MAX_CONCURRENT_IMAGE_JOBS, 4);
const MAX_RUNNING_JOBS_PER_USER = parsePositiveEnvInt(process.env.MAX_RUNNING_JOBS_PER_USER, 1);
const MAX_PENDING_JOBS_PER_USER = parsePositiveEnvInt(process.env.MAX_PENDING_JOBS_PER_USER, 3);

const activeAbortControllers = new Map<string, AbortController>();
const runningJobs = new Set<string>();

function parsePositiveEnvInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class ImageJobError extends Error {
  constructor(
    readonly code: "user_pending_full",
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ImageJobError";
  }
}

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
  // 1. Per-user pending cap (count only 'pending', not 'running').
  // Users can always queue one more behind their own running job.
  const pendingCount =
    db
      .select({ value: count() })
      .from(imageGenerationJobs)
      .where(
        and(
          eq(imageGenerationJobs.userId, input.userId),
          eq(imageGenerationJobs.status, "pending")
        )
      )
      .get()?.value ?? 0;

  if (pendingCount >= MAX_PENDING_JOBS_PER_USER) {
    throw new ImageJobError(
      "user_pending_full",
      `您当前已有 ${pendingCount} 个生成任务在队列中，请等待其中一个开始或完成后再试。`,
      429
    );
  }

  // 2. Reserve credits in its own transaction. If it throws (insufficient credits),
  // no debit happens and we propagate the error.
  const creditPerImage = creditCostForSize(input.payload.size, input.creditCosts);
  const reservedAmount = creditPerImage * input.payload.count;
  reserveGenerationCredits({
    userId: input.userId,
    requestedCount: input.payload.count,
    creditPerImage
  });

  // 3. Insert job as pending. On failure, refund the reservation.
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
    safeRefund(input.userId, reservedAmount);
    throw error;
  }

  // 4. Try to start immediately if a worker slot is free.
  // If not, the job stays pending and a future drainQueue (after another job
  // finishes) will pick it up.
  try {
    drainQueue();
  } catch (error) {
    console.error(
      "drainQueue from createImageJob failed:",
      error instanceof Error ? error.message : error
    );
  }

  return { jobId, reservedAmount };
}

/**
 * Fill empty worker slots from the pending queue.
 *
 * Picks the oldest pending job whose user has fewer than MAX_RUNNING_JOBS_PER_USER
 * running jobs (per-user fairness so one user can't monopolize the workers).
 *
 * Called after job finish, after pending cancel, when a job is created, and at boot.
 */
export function drainQueue(): void {
  while (runningJobs.size < MAX_CONCURRENT_IMAGE_JOBS) {
    const next = pickNextPendingJob();
    if (!next) {
      break;
    }
    if (!claimAndStart(next.id, next.userId)) {
      // Defensive: should not happen single-threaded. Bail to avoid loop.
      break;
    }
  }
}

interface PendingJobCandidate {
  id: string;
  userId: string;
}

function pickNextPendingJob(): PendingJobCandidate | undefined {
  const row = db
    .select({ id: imageGenerationJobs.id, userId: imageGenerationJobs.userId })
    .from(imageGenerationJobs)
    .where(
      and(
        eq(imageGenerationJobs.status, "pending"),
        sql`(SELECT COUNT(*) FROM image_generation_jobs r WHERE r.user_id = ${imageGenerationJobs.userId} AND r.status = 'running') < ${MAX_RUNNING_JOBS_PER_USER}`
      )
    )
    .orderBy(imageGenerationJobs.createdAt, imageGenerationJobs.id)
    .limit(1)
    .get();

  if (!row) {
    return undefined;
  }
  return { id: row.id, userId: row.userId };
}

/**
 * Atomically transition a pending job to running and start its worker.
 *
 * The UPDATE is guarded by status='pending' AND the per-user running cap, so a
 * concurrent cancel or a duplicate drain can't double-claim.
 *
 * Between the successful UPDATE and `void runJob(...)`, no `await` is allowed —
 * this is the window where DB shows running but the AbortController is not yet
 * registered. Keeping it synchronous closes that gap.
 */
function claimAndStart(jobId: string, userId: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .update(imageGenerationJobs)
    .set({ status: "running", updatedAt: now })
    .where(
      and(
        eq(imageGenerationJobs.id, jobId),
        eq(imageGenerationJobs.status, "pending"),
        sql`(SELECT COUNT(*) FROM image_generation_jobs r WHERE r.user_id = ${userId} AND r.status = 'running') < ${MAX_RUNNING_JOBS_PER_USER}`
      )
    )
    .run();

  if (result.changes !== 1) {
    return false;
  }

  const controller = new AbortController();
  activeAbortControllers.set(jobId, controller);
  runningJobs.add(jobId);

  void runJob(jobId, userId, controller.signal)
    .catch((error) => {
      console.error(
        "runJob unexpected throw:",
        error instanceof Error ? error.message : error
      );
    })
    .finally(() => {
      activeAbortControllers.delete(jobId);
      runningJobs.delete(jobId);
      try {
        drainQueue();
      } catch (error) {
        console.error(
          "drainQueue after job finish failed:",
          error instanceof Error ? error.message : error
        );
        setImmediate(() => {
          try {
            drainQueue();
          } catch (retryError) {
            console.error(
              "drainQueue retry also failed:",
              retryError instanceof Error ? retryError.message : retryError
            );
          }
        });
      }
    });

  return true;
}

async function runJob(jobId: string, userId: string, signal: AbortSignal): Promise<void> {
  const job = db.select().from(imageGenerationJobs).where(eq(imageGenerationJobs.id, jobId)).get();
  if (!job || job.userId !== userId) {
    return;
  }

  // Status was already transitioned to 'running' by claimAndStart's atomic UPDATE.
  // Do not re-write it here — that would race with cancel and recovery paths.

  try {
    if (signal.aborted) {
      throw new DOMException("Aborted before start.", "AbortError");
    }

    const provider = await createConfiguredImageProvider(signal);
    const payload = JSON.parse(job.inputJson) as ImageProviderInput | EditImageProviderInput;

    // Pass jobId so saveGenerationRecord finalizes the job inside the same
    // transaction that inserts the record. This is the fix for codex finding
    // #5 (broken invariant): a crash between record-insert and job-finish
    // can no longer leave a successful gallery entry while recovery refunds.
    const result =
      job.mode === "edit"
        ? await runReferenceImageGeneration(payload as EditImageProviderInput, provider, userId, signal, { jobId })
        : await runTextToImageGeneration(payload as ImageProviderInput, provider, userId, signal, { jobId });

    const successfulCount = result.record.outputs.filter(
      (output) => output.status === "succeeded" && output.asset
    ).length;
    const refundAmount = (payload.count - successfulCount) * job.creditPerImage;

    // jobFinalized is false only if a cancel won the race against the record
    // insert, which already refunded the full reservation. In that case, do
    // not refund the unused portion — that would over-credit the user.
    if (result.jobFinalized && refundAmount > 0) {
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

  // Pending job — no controller is registered yet. Atomically transition to
  // cancelled (the WHERE clause prevents a race with claimAndStart) and refund.
  const finished = finishActiveJob(jobId, {
    status: "cancelled",
    generationRecordId: null,
    errorCode: "cancelled",
    errorMessage: "用户取消。"
  });
  if (finished) {
    safeRefund(userId, job.reservedAmount);
    // Cancelling a pending job may unblock a different user — try draining.
    try {
      drainQueue();
    } catch (error) {
      console.error(
        "drainQueue after cancel failed:",
        error instanceof Error ? error.message : error
      );
    }
  }
  return finished;
}

export function getImageJobView(
  jobId: string,
  userId: string,
  recordResolver: (id: string) => GenerationRecord | null
): ImageJobView | undefined {
  const job = db.select().from(imageGenerationJobs).where(eq(imageGenerationJobs.id, jobId)).get();
  if (!job || job.userId !== userId) {
    return undefined;
  }
  return toJobView(job, recordResolver);
}

export function listRecentImageJobs(
  userId: string,
  limit = 50,
  recordResolver: (id: string) => GenerationRecord | null
): ImageJobView[] {
  const jobs = db
    .select()
    .from(imageGenerationJobs)
    .where(eq(imageGenerationJobs.userId, userId))
    .orderBy(desc(imageGenerationJobs.createdAt))
    .limit(limit)
    .all();
  return jobs.map((job) => toJobView(job, recordResolver));
}

export function listActiveImageJobs(
  userId: string,
  recordResolver: (id: string) => GenerationRecord | null
): ImageJobView[] {
  const jobs = db
    .select()
    .from(imageGenerationJobs)
    .where(
      and(
        eq(imageGenerationJobs.userId, userId),
        inArray(imageGenerationJobs.status, ["pending", "running"])
      )
    )
    .orderBy(imageGenerationJobs.createdAt)
    .all();
  return jobs.map((job) => toJobView(job, recordResolver));
}

/**
 * Boot recovery: only fail jobs that were 'running' when the previous process died.
 * Those jobs lost their AbortController and any in-progress upstream call, so
 * they must be marked failed and their credits refunded.
 *
 * 'pending' jobs survive restart and are picked up by the next drainQueue call.
 */
export function recoverInterruptedJobs(): number {
  const stuck = db
    .select()
    .from(imageGenerationJobs)
    .where(eq(imageGenerationJobs.status, "running"))
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

function finishActiveJob(
  jobId: string,
  input: {
    status: ImageJobStatus;
    generationRecordId: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }
): boolean {
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
    .where(
      and(
        eq(imageGenerationJobs.id, jobId),
        inArray(imageGenerationJobs.status, ["pending", "running"])
      )
    )
    .run();
  return result.changes > 0;
}

function toJobView(
  job: typeof imageGenerationJobs.$inferSelect,
  recordResolver: (id: string) => GenerationRecord | null
): ImageJobView {
  return {
    id: job.id,
    mode: job.mode as ImageMode,
    status: job.status as ImageJobStatus,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    record: job.generationRecordId ? recordResolver(job.generationRecordId) : null,
    queuePositionApprox: job.status === "pending" ? countPendingJobsAhead(job) : null
  };
}

/**
 * Approximate wait position: count of `pending` jobs strictly before this one in
 * (created_at, id) order. Approximate because per-user fairness can let a later
 * job leapfrog if its user has no running job, while the current user is blocked
 * by their own running job. Good enough to surface "前面约 N 个任务" to the UI.
 */
function countPendingJobsAhead(job: typeof imageGenerationJobs.$inferSelect): number {
  const result = db
    .select({ value: count() })
    .from(imageGenerationJobs)
    .where(
      and(
        eq(imageGenerationJobs.status, "pending"),
        sql`(${imageGenerationJobs.createdAt} < ${job.createdAt} OR (${imageGenerationJobs.createdAt} = ${job.createdAt} AND ${imageGenerationJobs.id} < ${job.id}))`
      )
    )
    .get();
  return result?.value ?? 0;
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
