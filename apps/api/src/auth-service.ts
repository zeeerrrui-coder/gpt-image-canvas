import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";
import { asc } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "./database.js";
import { creditTransactions, sessions, users } from "./schema.js";

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TOKEN_BYTES = 32;
export const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30;
const SESSION_DURATION_MS = 1000 * SESSION_DURATION_SECONDS;

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "disabled";

export interface AppUser {
  id: string;
  username: string;
  nickname: string | null;
  role: UserRole;
  status: UserStatus;
  credits: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterUserInput {
  username: string;
  password: string;
}

export interface LoginUserInput {
  username: string;
  password: string;
}

export interface LoginSession {
  token: string;
  user: AppUser;
  expiresAt: string;
}

export async function registerUser(input: RegisterUserInput): Promise<AppUser> {
  const username = parseUsername(input.username);
  assertUsablePassword(input.password);

  const bonusCredits = parseRegistrationBonusCredits(process.env.REGISTRATION_BONUS_CREDITS);
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    username,
    passwordHash: await hashPassword(input.password),
    nickname: null,
    role: "user",
    status: "active",
    credits: bonusCredits,
    createdAt: now,
    updatedAt: now
  } satisfies typeof users.$inferInsert;

  try {
    db.transaction((tx) => {
      tx.insert(users).values(row).run();
      if (bonusCredits > 0) {
        tx.insert(creditTransactions)
          .values({
            id: randomUUID(),
            userId: row.id,
            type: "registration_bonus",
            amount: bonusCredits,
            balanceAfter: bonusCredits,
            note: "新人注册赠送",
            createdAt: now
          })
          .run();
      }
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new Error("用户名已存在。");
    }
    throw error;
  }

  return toAppUser(row);
}

const MAX_REGISTRATION_BONUS_CREDITS = 1000;

function parseRegistrationBonusCredits(value: string | undefined): number {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/u.test(normalized)) {
    return 0;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_REGISTRATION_BONUS_CREDITS) {
    return 0;
  }
  return parsed;
}

export async function loginUser(input: LoginUserInput): Promise<LoginSession> {
  const username = parseUsername(input.username);
  const row = getUserRowByUsername(username);
  if (!row || !(await verifyPassword(input.password, row.passwordHash))) {
    throw new Error("用户名或密码不正确。");
  }
  if (row.status === "disabled") {
    throw new Error("账号已被禁用。");
  }

  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS).toISOString();
  db.insert(sessions)
    .values({
      id: randomUUID(),
      userId: row.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
      createdAt: now.toISOString()
    })
    .run();

  return {
    token,
    user: toAppUser(row),
    expiresAt
  };
}

export async function authenticateSessionToken(token: string | undefined): Promise<AppUser | undefined> {
  const trimmedToken = token?.trim();
  if (!trimmedToken) {
    return undefined;
  }

  const session = db.select().from(sessions).where(eq(sessions.tokenHash, hashSessionToken(trimmedToken))).get();
  if (!session) {
    return undefined;
  }

  if (Date.parse(session.expiresAt) <= Date.now()) {
    db.delete(sessions).where(eq(sessions.id, session.id)).run();
    return undefined;
  }

  const user = getUserRowById(session.userId);
  if (!user || user.status === "disabled") {
    return undefined;
  }

  return toAppUser(user);
}

export function logoutSessionToken(token: string | undefined): void {
  const trimmedToken = token?.trim();
  if (!trimmedToken) {
    return;
  }

  db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(trimmedToken))).run();
}

export async function ensureBootstrapAdmin(): Promise<AppUser | undefined> {
  const existingAdmin = db.select().from(users).where(eq(users.role, "admin")).get();
  if (existingAdmin) {
    return toAppUser(existingAdmin);
  }

  const username = process.env.ADMIN_USERNAME?.trim();
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!username || !password) {
    return undefined;
  }

  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    username: parseUsername(username),
    passwordHash: await hashPassword(password),
    nickname: null,
    role: "admin",
    status: "active",
    credits: 0,
    createdAt: now,
    updatedAt: now
  } satisfies typeof users.$inferInsert;

  try {
    db.insert(users).values(row).run();
    return toAppUser(row);
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const existing = getUserRowByUsername(row.username);
    return existing ? toAppUser(existing) : undefined;
  }
}

export function getUserById(userId: string): AppUser | undefined {
  const user = getUserRowById(userId);
  return user ? toAppUser(user) : undefined;
}

export function listUsers(): AppUser[] {
  return db.select().from(users).orderBy(asc(users.createdAt)).all().map(toAppUser);
}

const MAX_NICKNAME_LENGTH = 32;

export function updateUserNickname(userId: string, nickname: string | null): AppUser {
  const trimmed = typeof nickname === "string" ? nickname.trim() : null;
  if (trimmed !== null && trimmed.length > MAX_NICKNAME_LENGTH) {
    throw new Error(`昵称不能超过 ${MAX_NICKNAME_LENGTH} 个字符。`);
  }

  const updatedAt = new Date().toISOString();
  const result = db
    .update(users)
    .set({ nickname: trimmed && trimmed.length > 0 ? trimmed : null, updatedAt })
    .where(eq(users.id, userId))
    .run();
  if (result.changes === 0) {
    throw new Error("用户不存在。");
  }

  const row = getUserRowById(userId);
  if (!row) {
    throw new Error("用户不存在。");
  }
  return toAppUser(row);
}

export async function changeUserPassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
  assertUsablePassword(newPassword);

  const row = getUserRowById(userId);
  if (!row) {
    throw new Error("用户不存在。");
  }
  if (!(await verifyPassword(oldPassword, row.passwordHash))) {
    throw new Error("旧密码不正确。");
  }

  const updatedAt = new Date().toISOString();
  const newHash = await hashPassword(newPassword);
  db.transaction((tx) => {
    tx.update(users).set({ passwordHash: newHash, updatedAt }).where(eq(users.id, userId)).run();
    tx.delete(sessions).where(eq(sessions.userId, userId)).run();
  });
}

export async function adminResetUserPassword(userId: string, newPassword: string): Promise<void> {
  assertUsablePassword(newPassword);

  const row = getUserRowById(userId);
  if (!row) {
    throw new Error("用户不存在。");
  }

  const updatedAt = new Date().toISOString();
  const newHash = await hashPassword(newPassword);
  db.transaction((tx) => {
    tx.update(users).set({ passwordHash: newHash, updatedAt }).where(eq(users.id, userId)).run();
    tx.delete(sessions).where(eq(sessions.userId, userId)).run();
  });
}

export function setUserStatus(userId: string, status: "active" | "disabled"): AppUser {
  const updatedAt = new Date().toISOString();
  const result = db.update(users).set({ status, updatedAt }).where(eq(users.id, userId)).run();
  if (result.changes === 0) {
    throw new Error("用户不存在。");
  }
  if (status === "disabled") {
    db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }
  const row = getUserRowById(userId);
  if (!row) {
    throw new Error("用户不存在。");
  }
  return toAppUser(row);
}

export function deleteUserById(userId: string): void {
  const result = db.delete(users).where(eq(users.id, userId)).run();
  if (result.changes === 0) {
    throw new Error("用户不存在。");
  }
}

function parseUsername(value: string): string {
  const username = normalizeUsername(value);
  if (!username) {
    throw new Error("用户名不能为空。");
  }

  return username;
}

function assertUsablePassword(password: string): void {
  if (password.length < 8) {
    throw new Error("密码至少需要 8 位。");
  }
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
  return `scrypt:${salt}:${key.toString("base64url")}`;
}

async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const [, salt, storedKey] = passwordHash.split(":");
  if (!salt || !storedKey) {
    return false;
  }

  const expected = Buffer.from(storedKey, "base64url");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function getUserRowByUsername(username: string): typeof users.$inferSelect | undefined {
  return db.select().from(users).where(eq(users.username, username)).get();
}

function getUserRowById(userId: string): typeof users.$inferSelect | undefined {
  return db.select().from(users).where(eq(users.id, userId)).get();
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function toAppUser(row: typeof users.$inferSelect): AppUser {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname ?? null,
    role: row.role === "admin" ? "admin" : "user",
    status: row.status === "disabled" ? "disabled" : "active",
    credits: row.credits,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
