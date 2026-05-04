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
import { sessions, users } from "./schema.js";

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

  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    username,
    passwordHash: await hashPassword(input.password),
    role: "user",
    status: "active",
    credits: 0,
    createdAt: now,
    updatedAt: now
  } satisfies typeof users.$inferInsert;

  try {
    db.insert(users).values(row).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new Error("用户名已存在。");
    }
    throw error;
  }

  return toAppUser(row);
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
    role: row.role === "admin" ? "admin" : "user",
    status: row.status === "disabled" ? "disabled" : "active",
    credits: row.credits,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
