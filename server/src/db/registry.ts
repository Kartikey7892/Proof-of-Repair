/**
 * PostgreSQL VIN attestation registry.
 *
 * Structured repair proofs queryable by VIN; evidence blobs stay
 * content-addressed on disk; Merkle roots go to chain / OTS.
 */
import type { MerkleProof } from "../crypto/merkle.js";
import type { ProofOfRepair } from "../por/proof.js";
import { normVin, parseVehicle } from "../util/vehicle.js";
import type { Db } from "./index.js";

export interface AnchorMeta {
  batch_id: string;
  merkle_root: string;
  ots_receipt_id: string | null;
  ots_status: string | null;
  ots_mode: string | null;
  chain_tx: string | null;
  chain_network: string | null;
  chain_mode: string | null;
}

export interface SaveAnchorInput {
  batch_id: string;
  merkle_root: string;
  leaf_order: string[];
  proofs: MerkleProof[];
  ots_receipt?: Record<string, any> | null;
  chain_tx?: Record<string, any> | null;
}

export type TrustSummary = "verified_timeline" | "partial" | "sealed_only" | "empty";

const ANCHOR_COLS = `a.batch_id, a.merkle_root, a.ots_receipt_id, a.ots_status, a.ots_mode,
                     a.chain_tx, a.chain_network, a.chain_mode`;

export class VinRegistry {
  constructor(readonly db: Db) {}

  async upsertProof(por: ProofOfRepair, opts: { diagnosisMs?: number } = {}): Promise<void> {
    const report = (por.report ?? {}) as Record<string, any>;
    const v = parseVehicle(por.vehicle);
    await this.db.query(
      `INSERT INTO proofs (
         proof_id, vin, vehicle, vehicle_year, vehicle_make, vehicle_model, odometer_km,
         event_type, issuer_id, ts, sealed_at, leaf_digest, report_hash, evidence_cid,
         fault_code, severity, diagnosis, buyer_advice, confidence, estimated_minutes,
         engine, diagnosis_ms, report, model, extra, proof)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($10),$11,$12,$13,
               $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (proof_id) DO UPDATE SET
         vin=EXCLUDED.vin, vehicle=EXCLUDED.vehicle, vehicle_year=EXCLUDED.vehicle_year,
         vehicle_make=EXCLUDED.vehicle_make, vehicle_model=EXCLUDED.vehicle_model,
         odometer_km=EXCLUDED.odometer_km, event_type=EXCLUDED.event_type,
         issuer_id=EXCLUDED.issuer_id, ts=EXCLUDED.ts, sealed_at=EXCLUDED.sealed_at,
         leaf_digest=EXCLUDED.leaf_digest, report_hash=EXCLUDED.report_hash,
         evidence_cid=EXCLUDED.evidence_cid, fault_code=EXCLUDED.fault_code,
         severity=EXCLUDED.severity, diagnosis=EXCLUDED.diagnosis,
         buyer_advice=EXCLUDED.buyer_advice, confidence=EXCLUDED.confidence,
         estimated_minutes=EXCLUDED.estimated_minutes, engine=EXCLUDED.engine,
         diagnosis_ms=COALESCE(EXCLUDED.diagnosis_ms, proofs.diagnosis_ms),
         report=EXCLUDED.report, model=EXCLUDED.model, extra=EXCLUDED.extra,
         proof=EXCLUDED.proof`,
      [
        por.proof_id,
        normVin(por.vin),
        por.vehicle,
        v.year,
        v.make,
        v.model,
        por.odometer_km,
        por.event_type,
        por.issuer_id,
        por.timestamp,
        por.leaf_digest,
        por.report_hash,
        por.evidence_cid,
        report.fault_code ?? null,
        report.severity ?? null,
        report.diagnosis ?? null,
        report.buyer_advice ?? null,
        typeof report.confidence === "number" ? report.confidence : null,
        typeof report.estimated_minutes === "number" ? Math.trunc(report.estimated_minutes) : null,
        (por.extra?.engine as string | undefined) ?? null,
        opts.diagnosisMs ?? null,
        JSON.stringify(report),
        JSON.stringify(por.model ?? {}),
        JSON.stringify(por.extra ?? {}),
        JSON.stringify(por),
      ],
    );
  }

  private async withAnchors(rows: { proof_id: string; proof: ProofOfRepair }[]) {
    if (!rows.length) return [];
    const anchors = await this.latestAnchors(rows.map((r) => r.proof_id));
    return rows.map((r) => {
      const a = anchors.get(r.proof_id);
      return a ? { ...r.proof, anchor: a } : r.proof;
    });
  }

  async getProof(proofId: string): Promise<(ProofOfRepair & { anchor?: AnchorMeta }) | null> {
    const { rows } = await this.db.query<{ proof_id: string; proof: ProofOfRepair }>(
      "SELECT proof_id, proof FROM proofs WHERE proof_id = $1",
      [proofId],
    );
    return (await this.withAnchors(rows))[0] ?? null;
  }

  async listProofs(limit = 1000) {
    const { rows } = await this.db.query<{ proof_id: string; proof: ProofOfRepair }>(
      "SELECT proof_id, proof FROM proofs ORDER BY ts ASC LIMIT $1",
      [limit],
    );
    return this.withAnchors(rows);
  }

  /** Leaves sealed but not yet included in any anchored batch, oldest first. */
  async pendingLeaves(): Promise<string[]> {
    const { rows } = await this.db.query<{ leaf_digest: string }>(
      `SELECT p.leaf_digest FROM proofs p
       WHERE NOT EXISTS (SELECT 1 FROM proof_anchors pa WHERE pa.proof_id = p.proof_id)
       ORDER BY p.ts ASC`,
    );
    return rows.map((r) => r.leaf_digest);
  }

  async saveAnchor(input: SaveAnchorInput): Promise<AnchorMeta> {
    const ots = input.ots_receipt ?? {};
    const chain = input.chain_tx ?? {};
    const meta: AnchorMeta = {
      batch_id: input.batch_id,
      merkle_root: input.merkle_root,
      ots_receipt_id: ots.receipt_id ?? null,
      ots_status: ots.status ?? null,
      ots_mode: ots.mode ?? null,
      chain_tx: chain.tx_hash ?? null,
      chain_network: chain.network ?? null,
      chain_mode: chain.mode ?? null,
    };
    await this.db.tx(async (q) => {
      await q.query(
        `INSERT INTO anchors (batch_id, merkle_root, leaf_count, leaf_order, ots_receipt_id,
           ots_status, ots_mode, ots_receipt, chain_tx, chain_network, chain_mode, chain_receipt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (batch_id) DO UPDATE SET
           merkle_root=EXCLUDED.merkle_root, leaf_count=EXCLUDED.leaf_count,
           leaf_order=EXCLUDED.leaf_order, ots_receipt_id=EXCLUDED.ots_receipt_id,
           ots_status=EXCLUDED.ots_status, ots_mode=EXCLUDED.ots_mode,
           ots_receipt=EXCLUDED.ots_receipt, chain_tx=EXCLUDED.chain_tx,
           chain_network=EXCLUDED.chain_network, chain_mode=EXCLUDED.chain_mode,
           chain_receipt=EXCLUDED.chain_receipt`,
        [
          meta.batch_id,
          meta.merkle_root,
          input.leaf_order.length,
          JSON.stringify(input.leaf_order),
          meta.ots_receipt_id,
          meta.ots_status,
          meta.ots_mode,
          JSON.stringify(ots),
          meta.chain_tx,
          meta.chain_network,
          meta.chain_mode,
          JSON.stringify(chain),
        ],
      );
      // Link every proof whose leaf is in this batch, with its inclusion proof.
      await q.query(
        `INSERT INTO proof_anchors (proof_id, batch_id, leaf_index, merkle_proof)
         SELECT p.proof_id, $1, (x.mp->>'leaf_index')::int, x.mp
         FROM jsonb_array_elements($2::jsonb) AS x(mp)
         JOIN proofs p ON p.leaf_digest = x.mp->>'leaf_hash_hex'
         ON CONFLICT DO NOTHING`,
        [meta.batch_id, JSON.stringify(input.proofs)],
      );
    });
    return meta;
  }

  private async latestAnchors(proofIds: string[]): Promise<Map<string, AnchorMeta>> {
    const { rows } = await this.db.query<AnchorMeta & { proof_id: string }>(
      `SELECT DISTINCT ON (pa.proof_id) pa.proof_id, ${ANCHOR_COLS}
       FROM proof_anchors pa JOIN anchors a ON a.batch_id = pa.batch_id
       WHERE pa.proof_id = ANY($1::text[])
       ORDER BY pa.proof_id, a.created_at DESC`,
      [proofIds],
    );
    return new Map(rows.map(({ proof_id, ...a }) => [proof_id, a]));
  }

  /** Inclusion proof for a leaf from its most recent anchored batch. */
  async merkleProofForLeaf(leafDigest: string): Promise<MerkleProof | null> {
    const { rows } = await this.db.query<{ merkle_proof: MerkleProof }>(
      `SELECT pa.merkle_proof FROM proof_anchors pa
       JOIN proofs p ON p.proof_id = pa.proof_id
       JOIN anchors a ON a.batch_id = pa.batch_id
       WHERE p.leaf_digest = $1 ORDER BY a.created_at DESC LIMIT 1`,
      [leafDigest],
    );
    return rows[0]?.merkle_proof ?? null;
  }

  /** Full result of the most recently anchored batch (shape of POST /api/anchor_batch). */
  async lastBatch(): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query<any>(
      "SELECT * FROM anchors ORDER BY created_at DESC LIMIT 1",
    );
    const a = rows[0];
    if (!a) return {};
    const { rows: links } = await this.db.query<{ leaf_index: number; merkle_proof: MerkleProof }>(
      "SELECT leaf_index, merkle_proof FROM proof_anchors WHERE batch_id = $1 ORDER BY leaf_index",
      [a.batch_id],
    );
    return batchResult({
      batch_id: a.batch_id,
      merkle_root: a.merkle_root,
      ots_receipt: a.ots_receipt,
      chain_tx: a.chain_receipt && Object.keys(a.chain_receipt).length ? a.chain_receipt : null,
      leaf_order: a.leaf_order,
      proofs: links.map((l) => l.merkle_proof),
    });
  }

  async vinTimeline(vin: string) {
    const vinN = normVin(vin);
    const { rows } = await this.db.query<{ proof_id: string; proof: ProofOfRepair }>(
      "SELECT proof_id, proof FROM proofs WHERE vin = $1 ORDER BY ts ASC",
      [vinN],
    );
    const anchors = rows.length ? await this.latestAnchors(rows.map((r) => r.proof_id)) : new Map();
    const timeline = rows.map(({ proof: p, proof_id }) => {
      const report = (p.report ?? {}) as Record<string, any>;
      const anchor = anchors.get(proof_id) ?? {};
      return {
        proof_id: p.proof_id,
        when: p.timestamp,
        vehicle: p.vehicle,
        odometer_km: p.odometer_km,
        issuer_id: p.issuer_id,
        event_type: p.event_type,
        fault_code: report.fault_code,
        severity: report.severity,
        diagnosis: report.diagnosis,
        parts: report.parts ?? [],
        buyer_advice: report.buyer_advice,
        leaf_digest: p.leaf_digest,
        evidence_cid: p.evidence_cid,
        anchored: Boolean((anchor as AnchorMeta).merkle_root),
        anchor,
      };
    });
    const anchored = timeline.filter((e) => e.anchored).length;
    const trust: TrustSummary = !timeline.length
      ? "empty"
      : anchored === timeline.length
        ? "verified_timeline"
        : anchored > 0
          ? "partial"
          : "sealed_only";
    return {
      vin: vinN,
      count: timeline.length,
      anchored_count: anchored,
      timeline,
      trust_summary: trust,
      storage: "postgresql",
    };
  }

  async recordLookup(vin: string, resultCount: number, trust: string): Promise<void> {
    await this.db.query("INSERT INTO vin_lookups (vin, result_count, trust) VALUES ($1, $2, $3)", [
      normVin(vin),
      resultCount,
      trust,
    ]);
  }

  async stats() {
    const { rows } = await this.db.query<{ proofs: number; vins: number; anchors: number }>(
      `SELECT (SELECT COUNT(*) FROM proofs) AS proofs,
              (SELECT COUNT(DISTINCT vin) FROM proofs) AS vins,
              (SELECT COUNT(*) FROM anchors) AS anchors`,
    );
    return {
      backend: this.db.kind === "postgres" ? "postgresql" : "postgresql (embedded pglite)",
      path: this.db.label,
      ...rows[0]!,
      note: "Evidence blobs remain content-addressed files; Merkle roots on chain/OTS",
    };
  }
}

export function batchResult(b: {
  batch_id: string;
  merkle_root: string;
  ots_receipt: unknown;
  chain_tx: unknown;
  leaf_order: string[];
  proofs: MerkleProof[];
}) {
  return {
    batch_id: b.batch_id,
    merkle_root: b.merkle_root,
    ots_receipt: b.ots_receipt,
    chain_tx: b.chain_tx,
    proofs: Object.fromEntries(b.proofs.map((p) => [String(p.leaf_index), p])),
    proofs_by_leaf: Object.fromEntries(b.proofs.map((p) => [p.leaf_hash_hex, p])),
    leaf_order: b.leaf_order,
  };
}
