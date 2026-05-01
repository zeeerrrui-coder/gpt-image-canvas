import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ensureRuntimeStorage, runtimePaths, sqliteConfig } from "./runtime.js";
import * as schema from "./schema.js";

ensureRuntimeStorage();

const sqlite = new Database(runtimePaths.databaseFile);
configureSqlite(sqlite);

function configureSqlite(database: Database.Database): void {
  database.pragma(`locking_mode = ${sqliteConfig.lockingMode}`);
  database.pragma("foreign_keys = ON");
  applyJournalMode(database);
}

function applyJournalMode(database: Database.Database): void {
  try {
    database.pragma(`journal_mode = ${sqliteConfig.journalMode}`);
  } catch (error) {
    if (sqliteConfig.journalMode !== "WAL" || !isSharedMemoryOpenError(error)) {
      throw error;
    }

    console.warn("SQLite WAL mode is unavailable for DATA_DIR; falling back to DELETE journal mode.");
    database.pragma("locking_mode = EXCLUSIVE");
    database.pragma("journal_mode = DELETE");
  }
}

function isSharedMemoryOpenError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "SQLITE_IOERR_SHMOPEN"
  );
}

sqlite.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY NOT NULL,
  file_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  cloud_provider TEXT,
  cloud_bucket TEXT,
  cloud_region TEXT,
  cloud_object_key TEXT,
  cloud_status TEXT,
  cloud_error TEXT,
  cloud_uploaded_at TEXT,
  cloud_etag TEXT,
  cloud_request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_configs (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  secret_id TEXT,
  secret_key TEXT,
  bucket TEXT,
  region TEXT,
  key_prefix TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS codex_oauth_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  email TEXT,
  account_id TEXT,
  expires_at TEXT,
  refreshed_at TEXT,
  unavailable_at TEXT,
  unavailable_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_records (
  id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL,
  prompt TEXT NOT NULL,
  effective_prompt TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  quality TEXT NOT NULL,
  output_format TEXT NOT NULL,
  count INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  reference_asset_id TEXT REFERENCES assets(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_outputs (
  id TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL REFERENCES generation_records(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id),
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS generation_records_created_at_idx ON generation_records(created_at);
CREATE INDEX IF NOT EXISTS generation_outputs_generation_id_idx ON generation_outputs(generation_id);
CREATE INDEX IF NOT EXISTS generation_outputs_asset_id_idx ON generation_outputs(asset_id);
`);

ensureColumn("assets", "cloud_provider", "cloud_provider TEXT");
ensureColumn("assets", "cloud_bucket", "cloud_bucket TEXT");
ensureColumn("assets", "cloud_region", "cloud_region TEXT");
ensureColumn("assets", "cloud_object_key", "cloud_object_key TEXT");
ensureColumn("assets", "cloud_status", "cloud_status TEXT");
ensureColumn("assets", "cloud_error", "cloud_error TEXT");
ensureColumn("assets", "cloud_uploaded_at", "cloud_uploaded_at TEXT");
ensureColumn("assets", "cloud_etag", "cloud_etag TEXT");
ensureColumn("assets", "cloud_request_id", "cloud_request_id TEXT");
ensureColumn("codex_oauth_tokens", "access_token", "access_token TEXT");
ensureColumn("codex_oauth_tokens", "refresh_token", "refresh_token TEXT");
ensureColumn("codex_oauth_tokens", "id_token", "id_token TEXT");
ensureColumn("codex_oauth_tokens", "email", "email TEXT");
ensureColumn("codex_oauth_tokens", "account_id", "account_id TEXT");
ensureColumn("codex_oauth_tokens", "expires_at", "expires_at TEXT");
ensureColumn("codex_oauth_tokens", "refreshed_at", "refreshed_at TEXT");
ensureColumn("codex_oauth_tokens", "unavailable_at", "unavailable_at TEXT");
ensureColumn("codex_oauth_tokens", "unavailable_reason", "unavailable_reason TEXT");

export const db = drizzle(sqlite, { schema });

export function closeDatabase(): void {
  sqlite.close();
}

function ensureColumn(tableName: string, columnName: string, definition: string): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  sqlite.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}
