/** End-to-end HTTP tests against an in-memory PostgreSQL (PGlite). */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeAll(async () => {
  ctx = await makeTestApp();
}, 60_000);
afterAll(async () => {
  await ctx.db.close();
});

const civic = {
  vin: "1HGBH41JXMN109186",
  vehicle: "2016 Honda Civic",
  odometer_km: 98000,
  dtc_codes: "P0420",
  symptoms: "Check engine light on, failed emissions, slight sulfur smell from exhaust",
  sensor_notes: "rear O2 voltage lazy",
  engine: "kb",
};

describe("Proof-of-Repair API (FastAPI-compatible)", () => {
  it("health reports engines, storage and simulated chain/OTS", async () => {
    const res = await request(ctx.app).get("/api/health").expect(200);
    expect(res.body).toMatchObject({
      status: "ok",
      engines: { kb: true, tinyllama: false, mistral: false },
      chain: { mode: "in_memory_simulator" },
      ots: { mode: "sim" },
      pending_leaves: 0,
    });
    expect(res.body.storage.backend).toMatch(/postgresql/);
  });

  it("serves demo cases and the frontend", async () => {
    const demo = await request(ctx.app).get("/api/demo_cases").expect(200);
    expect(demo.body).toHaveLength(3);
    await request(ctx.app).get("/").expect(200).expect("content-type", /html/);
    await request(ctx.app).get("/assets/app.js").expect(200);
    await request(ctx.app).get("/vendor/chart.umd.js").expect(200);
    await request(ctx.app).get("/openapi.json").expect(200);
  });

  it("validates input with FastAPI-style 422s", async () => {
    const res = await request(ctx.app).post("/api/diagnose_and_prove").send({ vin: "short" }).expect(422);
    expect(Array.isArray(res.body.detail)).toBe(true);
    expect(res.body.detail[0].loc[0]).toBe("body");
  });

  it("unavailable LoRA engine → 400 with detail", async () => {
    const res = await request(ctx.app)
      .post("/api/diagnose_and_prove")
      .send({ ...civic, engine: "tinyllama" })
      .expect(400);
    expect(res.body.detail).toMatch(/sidecar/);
  });

  it("anchor with nothing pending → 400", async () => {
    const res = await request(ctx.app).post("/api/anchor_batch").send({}).expect(400);
    expect(res.body.detail).toMatch(/no leaves/);
  });

  let proof: any;
  it("diagnoses with the KB engine and seals a proof", async () => {
    const res = await request(ctx.app).post("/api/diagnose_and_prove").send(civic).expect(200);
    expect(res.body.engine).toBe("kb");
    expect(res.body.report.fault_code).toBe("P0420");
    expect(res.body.report.repair_steps.length).toBeGreaterThan(0);
    expect(res.body.report.parts.length).toBeGreaterThan(0);
    expect(res.body.report.confidence).toBeGreaterThan(0.8);
    expect(res.body.proof.vin).toBe(civic.vin);
    expect(res.body.proof.model.model_name).toMatch(/^kb:/);
    expect(res.body.proof.model.adapter_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.pending_batch_size).toBe(1);
    proof = res.body.proof;

    const ev = await request(ctx.app).get(`/api/evidence/${proof.evidence_cid}`).expect(200);
    expect(JSON.parse(ev.text).report.fault_code).toBe("P0420");
  });

  it("verifies before anchoring (no merkle proof yet)", async () => {
    const res = await request(ctx.app).post("/api/verify").send({ proof }).expect(200);
    expect(res.body).toMatchObject({ report_hash: true, leaf_digest: true, evidence: true, all_ok: true });
  });

  it("VIN timeline shows sealed_only, then verified after anchoring", async () => {
    let tl = await request(ctx.app).get(`/api/vin/${civic.vin.toLowerCase()}`).expect(200);
    expect(tl.body.trust_summary).toBe("sealed_only");

    // second vehicle, then anchor both in one batch
    await request(ctx.app)
      .post("/api/diagnose_and_prove")
      .send({ ...civic, vin: "4T1BF1FK5EU123456", vehicle: "2015 Toyota Camry", dtc_codes: "P0300", symptoms: "rough idle misfire" })
      .expect(200);
    const batch = await request(ctx.app).post("/api/anchor_batch").send({ batch_id: "t-1" }).expect(200);
    expect(batch.body.leaf_order).toHaveLength(2);
    expect(Object.keys(batch.body.proofs)).toEqual(["0", "1"]);
    expect(batch.body.proofs_by_leaf[proof.leaf_digest]).toBeDefined();
    expect(batch.body.chain_tx.tx_hash).toMatch(/^0x/);

    await request(ctx.app).post("/api/anchor_batch").send({ batch_id: "t-1", leaf_digests: [proof.leaf_digest] }).expect(409);

    tl = await request(ctx.app).get(`/api/vin/${civic.vin}`).expect(200);
    expect(tl.body.trust_summary).toBe("verified_timeline");
    expect(tl.body.timeline[0].anchor.batch_id).toBe("t-1");

    const last = await request(ctx.app).get("/api/last_batch").expect(200);
    expect(last.body.batch_id).toBe("t-1");
  });

  it("full verification uses the stored inclusion proof and chain anchor", async () => {
    const res = await request(ctx.app).post("/api/verify").send({ proof }).expect(200);
    expect(res.body).toEqual({ report_hash: true, leaf_digest: true, evidence: true, merkle: true, chain_anchor: true, all_ok: true });

    const tampered = { ...proof, odometer_km: 10 };
    const bad = await request(ctx.app).post("/api/verify").send({ proof: tampered }).expect(200);
    expect(bad.body.leaf_digest).toBe(false);
    expect(bad.body.all_ok).toBe(false);
  });

  it("lists and fetches proofs with anchor metadata", async () => {
    const list = await request(ctx.app).get("/api/proofs").expect(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0].anchor.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    const one = await request(ctx.app).get(`/api/proofs/${proof.proof_id}`).expect(200);
    expect(one.body.leaf_digest).toBe(proof.leaf_digest);
    await request(ctx.app).get("/api/proofs/nope").expect(404);
    await request(ctx.app).get("/api/vin/SHORT").expect(400);
  });

  it("back-compat aliases", async () => {
    await request(ctx.app).get("/health").expect(200);
  });
});

describe("analytics API", () => {
  it("overview reflects the sealed proofs and lookups", async () => {
    const res = await request(ctx.app).get("/api/analytics/overview").expect(200);
    expect(res.body.totals).toMatchObject({ proofs: 2, vins: 2, anchored_proofs: 2, pending_proofs: 0, batches: 1, anchor_rate: 1 });
    expect(res.body.proofs_per_day).toHaveLength(30);
    expect(res.body.proofs_per_day.at(-1).sealed).toBe(2);
    expect(res.body.top_fault_codes.map((c: any) => c.fault_code).sort()).toEqual(["P0300", "P0420"]);
    expect(res.body.buyer_lookups.total).toBeGreaterThanOrEqual(2);
    expect(res.body.engines[0].engine).toBe("kb");
  });

  it("NHTSA complaints, overall and filtered", async () => {
    const all = await request(ctx.app).get("/api/analytics/complaints").expect(200);
    expect(all.body.totals.complaints).toBe(4221);
    // Multi-component complaints count once per component (cross-checked in Python).
    expect(all.body.by_component.slice(0, 2)).toMatchObject([
      { component: "ENGINE", n: 804 },
      { component: "STEERING", n: 723 },
    ]);
    const civicOnly = await request(ctx.app).get("/api/analytics/complaints?make=honda&model=civic&year=2016").expect(200);
    expect(civicOnly.body.totals.complaints).toBe(1074);
    expect(civicOnly.body.by_vehicle).toHaveLength(1);
  });

  it("vehicle risk profile computes component lift vs fleet", async () => {
    const res = await request(ctx.app).get("/api/analytics/vehicle-risk").query({ vehicle: "2016 Honda Civic" }).expect(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.nhtsa.complaints).toBe(1074);
    expect(res.body.components[0]).toHaveProperty("lift");
    expect(res.body.registry.sealed_repairs).toBe(1);
    expect(res.body.headline).toMatch(/%/);
  });

  it("DTC knowledge analytics and per-code drilldown", async () => {
    const dtc = await request(ctx.app).get("/api/analytics/dtc").expect(200);
    expect(dtc.body.by_system.find((s: any) => s.system_category === "Powertrain").codes).toBe(84);
    const code = await request(ctx.app).get("/api/analytics/dtc/p0420").expect(200);
    expect(code.body.known).toBe(true);
    expect(code.body.fixes.length).toBeGreaterThan(0);
    expect(code.body.registry.sealed).toBe(1);
    await request(ctx.app).get("/api/analytics/dtc/nope").expect(400);
  });

  it("AI4I, model benchmarks and dataset lineage", async () => {
    const ai = await request(ctx.app).get("/api/analytics/ai4i").expect(200);
    expect(ai.body.totals.readings).toBe(10000);
    expect(ai.body.failure_modes).toHaveLength(5);
    const models = await request(ctx.app).get("/api/analytics/models").expect(200);
    const primary = models.body.find((m: any) => m.benchmark === "primary_obd_holdout_n57" && m.model === "mistral_mlx");
    expect(primary.fault_code_accuracy).toBeCloseTo(0.9825);
    const ds = await request(ctx.app).get("/api/analytics/datasets").expect(200);
    expect(ds.body.map((d: any) => d.dataset)).toContain("nhtsa_complaints");
  });
});
