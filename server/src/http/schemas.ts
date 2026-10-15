/** Request schemas (the Pydantic models of the FastAPI version). */
import { z } from "zod";
import { EVENT_TYPES } from "../por/proof.js";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected 32-byte lowercase hex");

export const DiagnoseRequest = z.object({
  vin: z.string().trim().min(11).max(32),
  vehicle: z.string().trim().min(1),
  odometer_km: z.coerce.number().int().min(0),
  symptoms: z.string().trim().min(1),
  dtc_codes: z.string().default(""),
  sensor_notes: z.string().default(""),
  issuer_id: z.string().trim().min(1).max(128).default("certified-workshop"),
  engine: z.string().default("auto").describe("kb | tinyllama | mistral | auto"),
  event_type: z.enum(EVENT_TYPES).default("REPAIR"),
});

export const AnchorBatchRequest = z.object({
  batch_id: z.string().trim().min(1).max(128).default("ui-batch-001"),
  leaf_digests: z.array(hex64).min(1).nullish().describe("defaults to every sealed-but-unanchored proof"),
});

export const MerkleProofSchema = z.object({
  leaf_index: z.number().int().min(0),
  leaf_hash_hex: hex64,
  siblings: z.array(hex64),
  root_hex: hex64,
});

// looseObject: extra keys (e.g. an embedded `anchor`) are kept but not hashed.
export const ProofSchema = z.looseObject({
    proof_id: z.string(),
    vin: z.string(),
    vehicle: z.string(),
    odometer_km: z.number(),
    event_type: z.string(),
    issuer_id: z.string(),
    timestamp: z.number(),
    report: z.record(z.string(), z.unknown()),
    evidence_cid: z.string(),
    report_hash: z.string(),
    model: z.record(z.string(), z.unknown()),
    leaf_digest: z.string(),
  extra: z.record(z.string(), z.unknown()).default({}),
});

export const VerifyRequest = z.object({
  proof: ProofSchema,
  merkle_proof: MerkleProofSchema.nullish(),
});
