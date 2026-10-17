/** Entry point: wire PostgreSQL, evidence store, anchoring and engines, then serve. */
import path from "node:path";
import { ROOT, config } from "./config.js";
import { runEtl } from "./analytics/etl.js";
import { Analytics } from "./analytics/queries.js";
import { loadLedger } from "./anchoring/ledger.js";
import { loadCalendar } from "./anchoring/ots.js";
import { AnchoringService } from "./anchoring/service.js";
import { createApp } from "./app.js";
import { openDb } from "./db/index.js";
import { VinRegistry } from "./db/registry.js";
import { EngineRegistry } from "./engines/index.js";
import { upgradePendingOts } from "./http/api.js";
import { EvidenceStore } from "./storage/evidence.js";

const db = await openDb({ url: config.databaseUrl, pgliteDir: config.pgliteDir });
console.log(`[db] ${db.label}`);

// First boot (or changed source files): load datasets for analytics + the KB engine.
await runEtl(db, ROOT, { log: console.log });

const registry = new VinRegistry(db);
const store = new EvidenceStore(path.join(config.artifactsDir, "evidence"), db);
const ledger = await loadLedger(config.chainConfig, path.join(config.artifactsDir, "sim_ledger.json"));
const calendar = loadCalendar(path.join(config.artifactsDir, "ots_calendar"), config.otsMode, config.otsCalendars);
const anchoring = new AnchoringService(calendar, ledger);
const engines = new EngineRegistry(db, ROOT, config.inferenceUrl);

const app = createApp({
  registry,
  store,
  anchoring,
  engines,
  analytics: new Analytics(db),
  frontendDir: config.frontendDir,
});

const server = app.listen(config.port, config.host, () => {
  console.log(`[api] Proof of Repair on http://${config.host}:${config.port}  (docs: /docs)`);
});

server.on("error", async (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n[api] Port ${config.port} is already in use — another copy of the server is probably still running.\n` +
        `      Stop it (Ctrl+C in its terminal), or start this one on another port, e.g. set PORT=8001 in .env.\n`,
    );
  } else {
    console.error("[api] server error:", err);
  }
  await db.close();
  process.exit(1);
});

// Pending OpenTimestamps receipts usually confirm in Bitcoin within hours.
const otsTimer = setInterval(
  () => void upgradePendingOts(registry, anchoring).catch((e) => console.warn(`[ots] ${e.message}`)),
  15 * 60_000,
);
otsTimer.unref();

const shutdown = async () => {
  server.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
