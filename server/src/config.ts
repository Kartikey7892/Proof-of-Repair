import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (the folder holding frontend/, artifacts/, data/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k: string, d = "") => (process.env[k] ?? d).trim();

/** Runtime state (evidence blobs, OTS receipts, simulator ledger, embedded DB). */
const artifactsDir = env("ARTIFACTS_DIR", path.join(ROOT, "artifacts"));

export const config = {
  port: Number(env("PORT", "8000")),
  host: env("HOST", "127.0.0.1"),
  /** postgres://user:pass@host:5432/db — when unset, an embedded PGlite Postgres is used. */
  databaseUrl: env("DATABASE_URL"),
  pgliteDir: env("PGLITE_DIR", path.join(artifactsDir, "pglite")),
  artifactsDir,
  dataDir: path.join(ROOT, "data"),
  frontendDir: path.join(ROOT, "frontend"),
  chainConfig: env("CHAIN_CONFIG", path.join(ROOT, "artifacts", "chain_config.json")),
  otsMode: env("OTS_MODE", "auto").toLowerCase(),
  otsCalendars: env("OTS_CALENDARS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Python inference sidecar (ml/inference_server.py) for the fine-tuned LoRA engines. */
  inferenceUrl: env("INFERENCE_URL", "http://127.0.0.1:8001"),
};
