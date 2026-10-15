import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "../src/config.js";
import { runEtl } from "../src/analytics/etl.js";
import { Analytics } from "../src/analytics/queries.js";
import { InMemoryLedger } from "../src/anchoring/ledger.js";
import { LocalCalendar } from "../src/anchoring/ots.js";
import { AnchoringService } from "../src/anchoring/service.js";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db/index.js";
import { VinRegistry } from "../src/db/registry.js";
import { EngineRegistry } from "../src/engines/index.js";
import { EvidenceStore } from "../src/storage/evidence.js";

/** Fresh in-memory Postgres (PGlite) + temp evidence dir + simulated anchoring. */
export async function makeTestApp(opts: { etl?: boolean } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), "por-test-"));
  const db = await openDb(); // memory://
  if (opts.etl !== false) await runEtl(db, ROOT);
  const registry = new VinRegistry(db);
  const store = new EvidenceStore(path.join(tmp, "evidence"), db);
  const ledger = new InMemoryLedger();
  const anchoring = new AnchoringService(new LocalCalendar(path.join(tmp, "ots")), ledger);
  // Point the sidecar at a closed port so LoRA engines report unavailable.
  const engines = new EngineRegistry(db, ROOT, "http://127.0.0.1:9");
  const app = createApp({ registry, store, anchoring, engines, analytics: new Analytics(db), frontendDir: path.join(ROOT, "frontend") });
  return { app, db, registry, store, ledger, anchoring, engines, tmp };
}
