/** Port of tests/test_por.py and tests/test_registry.py. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryLedger } from "../src/anchoring/ledger.js";
import { LocalCalendar } from "../src/anchoring/ots.js";
import { AnchoringService } from "../src/anchoring/service.js";
import { MerkleTree, leafHash } from "../src/crypto/merkle.js";
import { openDb } from "../src/db/index.js";
import { VinRegistry } from "../src/db/registry.js";
import { buildProof, type ModelProvenance, type RepairReport } from "../src/por/proof.js";
import { verifyFull, verifyLeafDigest, verifyReportHash } from "../src/por/verify.js";
import { EvidenceStore } from "../src/storage/evidence.js";

const model: ModelProvenance = {
  model_name: "peft:test",
  model_version: "1",
  adapter_hash: "",
  dataset_merkle_root: "",
  framework: "transformers+peft",
};

const report = (over: Partial<RepairReport> = {}): RepairReport => ({
  fault_code: "P0420",
  diagnosis: "catalyst efficiency below threshold",
  severity: "medium",
  parts: ["catalytic_converter"],
  repair_steps: ["test O2 sensors", "replace catalyst if needed"],
  qa_checks: ["readiness_monitors_ready"],
  estimated_minutes: 120,
  confidence: 0.88,
  buyer_advice: "Ask for post-repair emissions proof",
  ...over,
});

const tmp = () => mkdtempSync(path.join(tmpdir(), "por-"));

describe("crypto core", () => {
  it("merkle inclusion roundtrip", () => {
    const tree = new MerkleTree([0, 1, 2, 3, 4].map((i) => leafHash(Buffer.from(`leaf-${i}`))));
    for (let i = 0; i < 5; i++) expect(MerkleTree.verifyProof(tree.getProof(i))).toBe(true);
    const bad = { ...tree.getProof(2), leaf_index: 3 };
    expect(MerkleTree.verifyProof(bad)).toBe(false);
  });

  it("binds report hash and leaf digest; tampering is detected", async () => {
    const db = await openDb();
    const store = new EvidenceStore(path.join(tmp(), "ev"), db);
    const r = report();
    const cid = await store.putJson({ report: r });
    const por = buildProof({ vin: "1HGBH41JXMN109186", vehicle: "2016 Honda Civic", odometer_km: 98000, report: r, evidence_cid: cid, model });
    expect(verifyReportHash(por)).toBe(true);
    expect(verifyLeafDigest(por)).toBe(true);
    expect(await store.verify(cid)).toBe(true);

    const tampered = { ...por, report: { ...por.report, fault_code: "X" } };
    expect(verifyReportHash(tampered)).toBe(false);
    expect(verifyLeafDigest({ ...por, odometer_km: 12 })).toBe(false);
    await db.close();
  });

  it("anchors a batch and verifies every proof end-to-end", async () => {
    const dir = tmp();
    const db = await openDb();
    const store = new EvidenceStore(path.join(dir, "ev"), db);
    const ledger = new InMemoryLedger();
    const anchoring = new AnchoringService(new LocalCalendar(path.join(dir, "ots")), ledger);
    const proofs = [];
    for (let i = 0; i < 3; i++) {
      const r = report({ fault_code: "P0300", severity: "high", confidence: 0.8 });
      const cid = await store.putJson({ i, report: r });
      proofs.push(
        buildProof({ vin: `VIN${String(i).padStart(14, "0")}`, vehicle: "2015 Toyota Camry", odometer_km: 100000 + i, report: r, evidence_cid: cid, model }),
      );
    }
    const batch = await anchoring.anchorBatch(proofs.map((p) => p.leaf_digest), "veh1");
    expect(await ledger.isRootAnchored(batch.merkle_root)).toBe(true);
    expect(await anchoring.calendar.verify(batch.ots_receipt)).toBe(true);
    for (const [i, por] of proofs.entries()) {
      const v = await verifyFull(por, { store, merkleProof: batch.proofs[i], ledger });
      expect(v.all_ok).toBe(true);
    }
    await expect(anchoring.anchorBatch(proofs.map((p) => p.leaf_digest), "veh2")).rejects.toThrow(/already anchored/);
    await db.close();
  });
});

describe("PostgreSQL VIN registry", () => {
  it("timeline goes sealed_only → verified_timeline after anchoring", async () => {
    const db = await openDb();
    const reg = new VinRegistry(db);
    const por = buildProof({
      vin: "1hgbh41jxmn109186",
      vehicle: "2016 Honda Civic",
      odometer_km: 98000,
      report: report(),
      evidence_cid: "ef".repeat(32),
      model,
      issuer_id: "bay-1",
    });
    await reg.upsertProof(por);
    let tl = await reg.vinTimeline(" 1HGBH41JXMN109186 ");
    expect(tl.count).toBe(1);
    expect(tl.trust_summary).toBe("sealed_only");
    expect(await reg.pendingLeaves()).toEqual([por.leaf_digest]);

    const tree = MerkleTree.fromHex([por.leaf_digest]);
    await reg.saveAnchor({
      batch_id: "b1",
      merkle_root: tree.rootHex,
      leaf_order: [por.leaf_digest],
      proofs: [tree.getProof(0)],
      ots_receipt: { receipt_id: "r1", status: "confirmed", mode: "sim" },
      chain_tx: { tx_hash: "0xabc", network: "sim", mode: "in_memory_simulator" },
    });
    tl = await reg.vinTimeline("1HGBH41JXMN109186");
    expect(tl.trust_summary).toBe("verified_timeline");
    expect(tl.timeline[0]!.anchor).toMatchObject({ batch_id: "b1", chain_tx: "0xabc" });
    expect(await reg.pendingLeaves()).toEqual([]);
    expect(await reg.merkleProofForLeaf(por.leaf_digest)).toEqual(tree.getProof(0));

    const stats = await reg.stats();
    expect(stats).toMatchObject({ proofs: 1, vins: 1, anchors: 1 });
    const last = (await reg.lastBatch()) as any;
    expect(last.merkle_root).toBe(tree.rootHex);
    expect(last.proofs_by_leaf[por.leaf_digest].leaf_index).toBe(0);
    await db.close();
  });
});
