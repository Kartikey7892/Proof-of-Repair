/** Proof of Repair for second-hand vehicles — VIN-bound repair attestation. */
import { randomUUID } from "node:crypto";
import { canonicalDumps, POR_FLOAT_KEYS } from "../crypto/canonical.js";
import { sha256, sha256Hex } from "../crypto/merkle.js";

export const EVENT_TYPES = ["DIAGNOSIS", "REPAIR", "PARTS_REPLACE", "PPI_PASS", "OBD_CLEAR"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface ModelProvenance {
  model_name: string;
  model_version: string;
  adapter_hash: string;
  dataset_merkle_root: string;
  framework: string;
}

export interface RepairReport {
  fault_code: string;
  diagnosis: string;
  severity: string;
  parts: string[];
  repair_steps: string[];
  qa_checks: string[];
  estimated_minutes: number;
  confidence: number;
  buyer_advice: string;
}

export interface ProofOfRepair {
  proof_id: string;
  vin: string;
  vehicle: string;
  odometer_km: number;
  event_type: string;
  issuer_id: string;
  /** Unix seconds (Python float). */
  timestamp: number;
  report: Record<string, unknown>;
  evidence_cid: string;
  report_hash: string;
  model: Record<string, unknown>;
  leaf_digest: string;
  extra: Record<string, unknown>;
}

export const canonical = (obj: unknown): string => canonicalDumps(obj, { floatKeys: POR_FLOAT_KEYS });

export function reportHash(report: Record<string, unknown>): string {
  return sha256Hex(canonical(report));
}

export function payloadForLeaf(p: Omit<ProofOfRepair, "leaf_digest"> | ProofOfRepair) {
  return {
    proof_id: p.proof_id,
    vin: p.vin,
    vehicle: p.vehicle,
    odometer_km: p.odometer_km,
    event_type: p.event_type,
    issuer_id: p.issuer_id,
    timestamp: p.timestamp,
    report_hash: p.report_hash,
    evidence_cid: p.evidence_cid,
    model: p.model,
    extra: p.extra,
  };
}

export function computeLeafDigest(p: Omit<ProofOfRepair, "leaf_digest"> | ProofOfRepair): string {
  const payload = Buffer.from(canonical(payloadForLeaf(p)), "utf8");
  return sha256(Buffer.concat([Buffer.from([0x00]), payload])).toString("hex");
}

export interface BuildProofInput {
  vin: string;
  vehicle: string;
  odometer_km: number;
  report: RepairReport;
  evidence_cid: string;
  model: ModelProvenance;
  issuer_id?: string;
  event_type?: EventType;
  extra?: Record<string, unknown>;
  /** Overridable for tests; defaults to now. */
  timestamp?: number;
  proof_id?: string;
}

export function buildProof(input: BuildProofInput): ProofOfRepair {
  const report = { ...input.report } as unknown as Record<string, unknown>;
  const base = {
    proof_id: input.proof_id ?? randomUUID(),
    vin: input.vin.toUpperCase(),
    vehicle: input.vehicle,
    odometer_km: Math.trunc(input.odometer_km),
    event_type: input.event_type ?? "REPAIR",
    issuer_id: input.issuer_id ?? "certified-workshop",
    timestamp: input.timestamp ?? Date.now() / 1000,
    report,
    evidence_cid: input.evidence_cid,
    report_hash: reportHash(report),
    model: { ...input.model } as unknown as Record<string, unknown>,
    extra: input.extra ?? {},
  };
  return { ...base, leaf_digest: computeLeafDigest(base) };
}
