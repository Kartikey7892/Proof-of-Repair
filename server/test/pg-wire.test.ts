/**
 * Exercises the real `pg` driver path (PgDb: pool, transactions, type parsers)
 * over the Postgres wire protocol, using PGlite's socket server as the server.
 * Set TEST_DATABASE_URL to run the same checks against your own PostgreSQL.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "../src/config.js";
import { runEtl } from "../src/analytics/etl.js";
import { Analytics } from "../src/analytics/queries.js";
import { openDb, type Db } from "../src/db/index.js";
import { VinRegistry } from "../src/db/registry.js";
import { MerkleTree } from "../src/crypto/merkle.js";
import { buildProof } from "../src/por/proof.js";

let server: PGLiteSocketServer | null = null;
let backing: PGlite | null = null;
let db: Db;

beforeAll(async () => {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    backing = await PGlite.create();
    server = new PGLiteSocketServer({ db: backing, port: 54329, host: "127.0.0.1" });
    await server.start();
    url = "postgres://postgres:postgres@127.0.0.1:54329/postgres?sslmode=disable";
  }
  // PGlite serves one connection at a time.
  db = await openDb({ url, poolMax: 1 });
}, 60_000);

afterAll(async () => {
  await db?.close();
  await server?.stop();
  await backing?.close();
});

describe("pg driver over the wire", () => {
  it("connects as a real PostgreSQL client and migrates", async () => {
    expect(db.kind).toBe("postgres");
    const { rows } = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM schema_migrations");
    expect(rows[0]!.n).toBe(2); // BIGINT parsed to a JS number
  });

  it("runs the ETL and analytics through pg", async () => {
    const report = await runEtl(db, ROOT);
    expect(report.find((r) => r.dataset === "nhtsa_complaints")!.rows).toBe(4221);
    const c = await new Analytics(db).complaints({ make: "TOYOTA" });
    expect(c.totals.complaints).toBe(536);
  }, 60_000);

  it("registry transactions commit and roll back", async () => {
    const reg = new VinRegistry(db);
    const proof = buildProof({
      vin: "4T1BF1FK5EU123456",
      vehicle: "2015 Toyota Camry",
      odometer_km: 142000,
      report: {
        fault_code: "P0300", diagnosis: "random misfire", severity: "high", parts: [], repair_steps: [],
        qa_checks: [], estimated_minutes: 60, confidence: 1, buyer_advice: "",
      },
      evidence_cid: "ab".repeat(32),
      model: { model_name: "kb", model_version: "1", adapter_hash: "", dataset_merkle_root: "", framework: "x" },
    });
    await reg.upsertProof(proof);
    const tree = MerkleTree.fromHex([proof.leaf_digest]);
    await reg.saveAnchor({ batch_id: "w1", merkle_root: tree.rootHex, leaf_order: [proof.leaf_digest], proofs: [tree.getProof(0)] });
    expect((await reg.vinTimeline(proof.vin)).trust_summary).toBe("verified_timeline");

    await expect(
      db.tx(async (q) => {
        await q.query("INSERT INTO anchors (batch_id, merkle_root, leaf_count, leaf_order) VALUES ('w2', 'x', 0, '[]')");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { rows } = await db.query("SELECT 1 FROM anchors WHERE batch_id = 'w2'");
    expect(rows).toHaveLength(0);
  });
});
