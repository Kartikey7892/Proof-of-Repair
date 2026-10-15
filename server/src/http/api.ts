/**
 * Core Proof-of-Repair API — same paths and response shapes as the FastAPI
 * service (src/cloud/api.py), so the existing frontend works unchanged.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AnchoringService } from "../anchoring/service.js";
import type { TimestampReceipt } from "../anchoring/ots.js";
import { batchResult, type VinRegistry } from "../db/registry.js";
import type { EngineRegistry } from "../engines/index.js";
import { buildProof, type ProofOfRepair } from "../por/proof.js";
import { verifyFull } from "../por/verify.js";
import type { EvidenceStore } from "../storage/evidence.js";
import { normVin } from "../util/vehicle.js";
import { DEMO_CASES } from "./demo.js";
import { HttpError, asyncRoute, parseBody } from "./errors.js";
import { AnchorBatchRequest, DiagnoseRequest, VerifyRequest } from "./schemas.js";

export interface ApiDeps {
  registry: VinRegistry;
  store: EvidenceStore;
  anchoring: AnchoringService;
  engines: EngineRegistry;
}

/** Serialize batch anchoring so two requests never claim the same pending leaves. */
function mutex() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

export function apiRouter({ registry, store, anchoring, engines }: ApiDeps): Router {
  const r = Router();
  const anchorLock = mutex();

  const health = async (_req: Request, res: Response) => {
    const [engineState, chain, storage, pending] = await Promise.all([
      engines.availability(),
      anchoring.ledger
        ? anchoring.ledger.status().catch((e: Error) => ({ mode: "error", detail: e.message }))
        : Promise.resolve({ mode: "disabled" }),
      registry.stats(),
      registry.pendingLeaves(),
    ]);
    res.json({
      status: "ok",
      domain: "second_hand_vehicle_por",
      backend: "node+express",
      engines: engineState,
      chain,
      ots: anchoring.calendar.status(),
      storage,
      pending_leaves: pending.length,
      proofs: storage.proofs,
    });
  };

  const diagnoseAndProve = async (req: Request, res: Response) => {
    const body = parseBody(DiagnoseRequest, req.body);
    const engine = await engines.resolve(body.engine);
    const input = {
      vehicle: body.vehicle,
      symptoms: body.symptoms,
      dtc_codes: body.dtc_codes,
      sensor_notes: body.sensor_notes,
    };
    const t0 = performance.now();
    const { report, model } = await engine.diagnose(input);
    const diagnosisMs = Math.round(performance.now() - t0);

    const evidence_cid = await store.putJson(
      { vin: body.vin, odometer_km: body.odometer_km, ...input, report },
      { type: "vehicle_repair_evidence" },
    );
    const proof = buildProof({
      vin: body.vin,
      vehicle: body.vehicle,
      odometer_km: body.odometer_km,
      report,
      evidence_cid,
      model,
      issuer_id: body.issuer_id,
      event_type: body.event_type,
      extra: { audience: "second_hand_buyer", engine: engine.name },
    });
    await registry.upsertProof(proof, { diagnosisMs });
    const pending = await registry.pendingLeaves();
    res.json({
      engine: engine.name,
      report,
      proof,
      pending_batch_size: pending.length,
      diagnosis_ms: diagnosisMs,
    });
  };

  r.get("/api/health", asyncRoute(health));
  r.get("/health", asyncRoute(health));

  r.get("/api/demo_cases", (_req, res) => {
    res.json(DEMO_CASES);
  });

  r.post("/api/diagnose_and_prove", asyncRoute(diagnoseAndProve));
  r.post("/diagnose_and_prove", asyncRoute(diagnoseAndProve));

  r.post(
    "/api/anchor_batch",
    asyncRoute(async (req, res) => {
      const body = parseBody(AnchorBatchRequest, req.body ?? {});
      const result = await anchorLock(async () => {
        const leaves = body.leaf_digests ?? (await registry.pendingLeaves());
        if (!leaves.length) throw new HttpError(400, "no leaves to anchor — diagnose at least one VIN first");
        const { rows } = await registry.db.query("SELECT 1 FROM anchors WHERE batch_id = $1", [body.batch_id]);
        if (rows.length) throw new HttpError(409, `batch_id '${body.batch_id}' already anchored`);

        const out = await anchoring.anchorBatch(leaves, body.batch_id);
        await registry.saveAnchor({
          batch_id: out.batch_id,
          merkle_root: out.merkle_root,
          leaf_order: leaves,
          proofs: out.proofs,
          ots_receipt: out.ots_receipt as unknown as Record<string, unknown>,
          chain_tx: out.chain_tx,
        });
        return batchResult({ ...out, leaf_order: leaves });
      });
      res.json(result);
    }),
  );

  r.post(
    "/api/verify",
    asyncRoute(async (req, res) => {
      const body = parseBody(VerifyRequest, req.body);
      const proof = body.proof as unknown as ProofOfRepair;
      const merkleProof = body.merkle_proof ?? (await registry.merkleProofForLeaf(proof.leaf_digest));
      res.json(await verifyFull(proof, { store, merkleProof, ledger: anchoring.ledger ?? undefined }));
    }),
  );

  r.get(
    "/api/proofs",
    asyncRoute(async (req, res) => {
      const limit = z.coerce.number().int().min(1).max(10_000).catch(1000).parse(req.query.limit);
      res.json(await registry.listProofs(limit));
    }),
  );

  r.get(
    "/api/proofs/:proofId",
    asyncRoute(async (req, res) => {
      const proof = await registry.getProof(String(req.params.proofId));
      if (!proof) throw new HttpError(404, "proof not found");
      res.json(proof);
    }),
  );

  r.get(
    "/api/vin/:vin",
    asyncRoute(async (req, res) => {
      const vin = String(req.params.vin);
      if (normVin(vin).length < 11) throw new HttpError(400, "VIN too short");
      const timeline = await registry.vinTimeline(vin);
      await registry.recordLookup(vin, timeline.count, timeline.trust_summary).catch(() => {});
      res.json(timeline);
    }),
  );

  r.get(
    "/api/last_batch",
    asyncRoute(async (_req, res) => {
      res.json(await registry.lastBatch());
    }),
  );

  r.get(
    "/api/evidence/:cid",
    asyncRoute(async (req, res) => {
      const cid = String(req.params.cid);
      if (!/^[0-9a-f]{64}$/.test(cid)) throw new HttpError(400, "invalid cid");
      if (!(await store.verify(cid))) throw new HttpError(404, "evidence not found or corrupted");
      res.type("application/json").send(await store.getBytes(cid));
    }),
  );

  /** Re-check pending OpenTimestamps receipts for Bitcoin confirmation. */
  r.post(
    "/api/ots/upgrade",
    asyncRoute(async (_req, res) => {
      res.json(await upgradePendingOts(registry, anchoring));
    }),
  );

  return r;
}

export async function upgradePendingOts(registry: VinRegistry, anchoring: AnchoringService) {
  const cal = anchoring.calendar;
  const { rows } = await registry.db.query<{ batch_id: string; ots_receipt: TimestampReceipt }>(
    "SELECT batch_id, ots_receipt FROM anchors WHERE ots_status = 'pending' ORDER BY created_at LIMIT 50",
  );
  const results: { batch_id: string; status: string; bitcoin_block_height: number | null }[] = [];
  for (const row of rows) {
    let r = row.ots_receipt;
    try {
      if (cal.upgrade) r = await cal.upgrade(r);
    } catch (e) {
      console.warn(`[ots] upgrade ${row.batch_id} failed: ${(e as Error).message}`);
    }
    if (r.status !== row.ots_receipt.status) {
      await registry.db.query("UPDATE anchors SET ots_status = $2, ots_receipt = $3 WHERE batch_id = $1", [
        row.batch_id,
        r.status,
        JSON.stringify(r),
      ]);
    }
    results.push({ batch_id: row.batch_id, status: r.status, bitcoin_block_height: r.bitcoin_block_height });
  }
  return { checked: rows.length, confirmed: results.filter((x) => x.status === "confirmed").length, results };
}
