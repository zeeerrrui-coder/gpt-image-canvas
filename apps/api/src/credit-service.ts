import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./database.js";
import { creditTransactions, users } from "./schema.js";
import type { AppUser } from "./auth-service.js";

export interface GrantUserCreditsInput {
  userId: string;
  amount: number;
  adminId: string;
  note?: string;
}

export interface DeductGenerationCreditsInput {
  userId: string;
  generationId: string;
  successfulOutputs: number;
}

export interface ReserveGenerationCreditsInput {
  userId: string;
  requestedCount: number;
}

export interface RefundGenerationCreditsInput {
  userId: string;
  generationId?: string;
  amount: number;
}

export class CreditError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "CreditError";
    this.code = code;
    this.status = status;
  }
}

export function grantUserCredits(input: GrantUserCreditsInput): AppUser {
  const amount = parseCreditAmount(input.amount);
  return db.transaction((tx) => {
    const user = tx.select().from(users).where(eq(users.id, input.userId)).get();
    if (!user) {
      throw new Error("用户不存在。");
    }

    const nextCredits = user.credits + amount;
    if (nextCredits < 0) {
      throw new Error("积分余额不能小于 0。");
    }

    const updatedAt = new Date().toISOString();
    tx.update(users).set({ credits: nextCredits, updatedAt }).where(eq(users.id, user.id)).run();
    tx.insert(creditTransactions)
      .values({
        id: randomUUID(),
        userId: user.id,
        type: amount >= 0 ? "admin_grant" : "admin_revoke",
        amount,
        balanceAfter: nextCredits,
        adminId: input.adminId,
        note: input.note?.trim() || null,
        createdAt: updatedAt
      })
      .run();

    return {
      id: user.id,
      username: user.username,
      role: user.role === "admin" ? "admin" : "user",
      status: user.status === "disabled" ? "disabled" : "active",
      credits: nextCredits,
      createdAt: user.createdAt,
      updatedAt
    };
  });
}

export function assertUserHasCredits(userId: string, requestedCount: number): void {
  const count = parseRequestedCount(requestedCount);
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) {
    throw new CreditError("unauthorized", "请先登录。", 401);
  }
  if (user.credits < count) {
    throw new CreditError("insufficient_credits", "积分不足，请联系管理员发放积分。", 402);
  }
}

export function reserveGenerationCredits(input: ReserveGenerationCreditsInput): AppUser {
  const amount = parseRequestedCount(input.requestedCount);
  return db.transaction((tx) => {
    const user = tx.select().from(users).where(eq(users.id, input.userId)).get();
    if (!user) {
      throw new CreditError("unauthorized", "请先登录。", 401);
    }
    if (user.credits < amount) {
      throw new CreditError("insufficient_credits", "积分不足，请联系管理员发放积分。", 402);
    }

    const nextCredits = user.credits - amount;
    const updatedAt = new Date().toISOString();
    tx.update(users).set({ credits: nextCredits, updatedAt }).where(eq(users.id, user.id)).run();
    tx.insert(creditTransactions)
      .values({
        id: randomUUID(),
        userId: user.id,
        type: "generation_reserve",
        amount: -amount,
        balanceAfter: nextCredits,
        createdAt: updatedAt
      })
      .run();

    return toAppUser({
      ...user,
      credits: nextCredits,
      updatedAt
    });
  });
}

export function refundGenerationCredits(input: RefundGenerationCreditsInput): AppUser {
  const amount = parseRefundAmount(input.amount);
  if (amount === 0) {
    const user = db.select().from(users).where(eq(users.id, input.userId)).get();
    if (!user) {
      throw new CreditError("unauthorized", "请先登录。", 401);
    }
    return toAppUser(user);
  }

  return db.transaction((tx) => {
    const user = tx.select().from(users).where(eq(users.id, input.userId)).get();
    if (!user) {
      throw new CreditError("unauthorized", "请先登录。", 401);
    }

    const nextCredits = user.credits + amount;
    const updatedAt = new Date().toISOString();
    tx.update(users).set({ credits: nextCredits, updatedAt }).where(eq(users.id, user.id)).run();
    tx.insert(creditTransactions)
      .values({
        id: randomUUID(),
        userId: user.id,
        type: "generation_refund",
        amount,
        balanceAfter: nextCredits,
        generationId: input.generationId,
        createdAt: updatedAt
      })
      .run();

    return toAppUser({
      ...user,
      credits: nextCredits,
      updatedAt
    });
  });
}

export function deductGenerationCredits(input: DeductGenerationCreditsInput): AppUser {
  const amount = parseSuccessfulOutputCount(input.successfulOutputs);
  if (amount === 0) {
    const user = db.select().from(users).where(eq(users.id, input.userId)).get();
    if (!user) {
      throw new CreditError("unauthorized", "请先登录。", 401);
    }
    return toAppUser(user);
  }

  return db.transaction((tx) => {
    const user = tx.select().from(users).where(eq(users.id, input.userId)).get();
    if (!user) {
      throw new CreditError("unauthorized", "请先登录。", 401);
    }
    if (user.credits < amount) {
      throw new CreditError("insufficient_credits", "积分不足，请联系管理员发放积分。", 402);
    }

    const nextCredits = user.credits - amount;
    const updatedAt = new Date().toISOString();
    tx.update(users).set({ credits: nextCredits, updatedAt }).where(eq(users.id, user.id)).run();
    tx.insert(creditTransactions)
      .values({
        id: randomUUID(),
        userId: user.id,
        type: "generation_deduct",
        amount: -amount,
        balanceAfter: nextCredits,
        generationId: input.generationId,
        createdAt: updatedAt
      })
      .run();

    return toAppUser({
      ...user,
      credits: nextCredits,
      updatedAt
    });
  });
}

function parseCreditAmount(value: number): number {
  if (!Number.isInteger(value) || value === 0) {
    throw new Error("积分变动必须是非零整数。");
  }
  return value;
}

function parseRequestedCount(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CreditError("invalid_request", "生成数量必须是正整数。", 400);
  }
  return value;
}

function parseSuccessfulOutputCount(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new CreditError("invalid_request", "成功生成数量必须是非负整数。", 400);
  }
  return value;
}

function parseRefundAmount(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new CreditError("invalid_request", "退回积分必须是非负整数。", 400);
  }
  return value;
}

function toAppUser(row: typeof users.$inferSelect): AppUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role === "admin" ? "admin" : "user",
    status: row.status === "disabled" ? "disabled" : "active",
    credits: row.credits,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
