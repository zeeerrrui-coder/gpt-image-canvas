import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./database.js";
import { creditTransactions, redeemCodeUses, redeemCodes, users } from "./schema.js";
import type { AppUser } from "./auth-service.js";

export interface RedeemCodeView {
  id: string;
  code: string;
  credits: number;
  maxUses: number;
  usesCount: number;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
}

export interface CreateRedeemCodeInput {
  credits: number;
  maxUses?: number;
  expiresAt?: string | null;
  note?: string;
  adminId: string;
}

const MAX_CREDITS_PER_CODE = 10000;
const MAX_USES_DEFAULT = 1;

export function listRedeemCodes(): RedeemCodeView[] {
  return db.select().from(redeemCodes).orderBy(desc(redeemCodes.createdAt)).all().map((row) => ({
    id: row.id,
    code: row.code,
    credits: row.credits,
    maxUses: row.maxUses,
    usesCount: row.usesCount,
    expiresAt: row.expiresAt,
    note: row.note,
    createdAt: row.createdAt
  }));
}

export function createRedeemCode(input: CreateRedeemCodeInput): RedeemCodeView {
  if (!Number.isInteger(input.credits) || input.credits <= 0 || input.credits > MAX_CREDITS_PER_CODE) {
    throw new Error(`积分必须是 1-${MAX_CREDITS_PER_CODE} 之间的正整数。`);
  }
  const maxUses = input.maxUses ?? MAX_USES_DEFAULT;
  if (!Number.isInteger(maxUses) || maxUses <= 0) {
    throw new Error("使用次数必须是正整数。");
  }
  const expiresAt = parseExpiresAt(input.expiresAt);
  const note = input.note?.trim() || null;
  const now = new Date().toISOString();
  const code = generateCode();

  const id = randomUUID();
  db.insert(redeemCodes)
    .values({
      id,
      code,
      credits: input.credits,
      maxUses,
      usesCount: 0,
      expiresAt,
      note,
      adminId: input.adminId,
      createdAt: now,
      updatedAt: now
    })
    .run();

  return {
    id,
    code,
    credits: input.credits,
    maxUses,
    usesCount: 0,
    expiresAt,
    note,
    createdAt: now
  };
}

export function deleteRedeemCode(id: string): void {
  const result = db.delete(redeemCodes).where(eq(redeemCodes.id, id)).run();
  if (result.changes === 0) {
    throw new Error("兑换码不存在。");
  }
}

export function redeemCode(input: { code: string; userId: string }): { user: AppUser; credits: number } {
  const code = input.code.trim();
  if (!code) {
    throw new Error("请输入兑换码。");
  }

  return db.transaction((tx) => {
    const codeRow = tx.select().from(redeemCodes).where(eq(redeemCodes.code, code)).get();
    if (!codeRow) {
      throw new Error("兑换码不存在。");
    }
    if (codeRow.expiresAt && Date.parse(codeRow.expiresAt) <= Date.now()) {
      throw new Error("兑换码已过期。");
    }
    if (codeRow.usesCount >= codeRow.maxUses) {
      throw new Error("兑换码已用完。");
    }

    const existingUse = tx
      .select()
      .from(redeemCodeUses)
      .where(and(eq(redeemCodeUses.codeId, codeRow.id), eq(redeemCodeUses.userId, input.userId)))
      .get();
    if (existingUse) {
      throw new Error("你已经兑换过这个兑换码。");
    }

    const userRow = tx.select().from(users).where(eq(users.id, input.userId)).get();
    if (!userRow) {
      throw new Error("用户不存在。");
    }

    const now = new Date().toISOString();
    const nextCredits = userRow.credits + codeRow.credits;

    tx.update(users).set({ credits: nextCredits, updatedAt: now }).where(eq(users.id, input.userId)).run();
    tx.update(redeemCodes).set({ usesCount: codeRow.usesCount + 1, updatedAt: now }).where(eq(redeemCodes.id, codeRow.id)).run();
    tx.insert(redeemCodeUses).values({
      id: randomUUID(),
      codeId: codeRow.id,
      userId: input.userId,
      credits: codeRow.credits,
      createdAt: now
    }).run();
    tx.insert(creditTransactions).values({
      id: randomUUID(),
      userId: input.userId,
      type: "redeem_code",
      amount: codeRow.credits,
      balanceAfter: nextCredits,
      note: `兑换码：${codeRow.code}`,
      createdAt: now
    }).run();

    return {
      credits: codeRow.credits,
      user: {
        id: userRow.id,
        username: userRow.username,
        nickname: userRow.nickname ?? null,
        role: userRow.role === "admin" ? "admin" : "user",
        status: userRow.status === "disabled" ? "disabled" : "active",
        credits: nextCredits,
        createdAt: userRow.createdAt,
        updatedAt: now
      }
    };
  });
}

function generateCode(): string {
  const bytes = randomBytes(8);
  let str = "";
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let index = 0; index < 12; index += 1) {
    str += chars[bytes[index % bytes.length] % chars.length];
    if (index === 3 || index === 7) {
      str += "-";
    }
  }
  return str;
}

function parseExpiresAt(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("过期时间格式不正确。");
  }
  return parsed.toISOString();
}
