/** Independent verification of vehicle Proof-of-Repair objects. */
import { MerkleTree, type MerkleProof } from "../crypto/merkle.js";
import { computeLeafDigest, reportHash, type ProofOfRepair } from "./proof.js";

export interface EvidenceVerifier {
  verify(cid: string): Promise<boolean>;
}
export interface AnchorChecker {
  isRootAnchored(rootHex: string): Promise<boolean>;
}

export interface VerifyResult {
  report_hash: boolean;
  leaf_digest: boolean;
  evidence: boolean;
  merkle: boolean;
  chain_anchor: boolean;
  all_ok: boolean;
}

export const verifyReportHash = (p: ProofOfRepair) => reportHash(p.report) === p.report_hash;
export const verifyLeafDigest = (p: ProofOfRepair) => computeLeafDigest(p) === p.leaf_digest;

export function verifyMerkleInclusion(proof: MerkleProof, leafDigestHex: string): boolean {
  if (proof.leaf_hash_hex !== leafDigestHex) return false;
  return MerkleTree.verifyProof(proof);
}

export async function verifyFull(
  por: ProofOfRepair,
  opts: { store?: EvidenceVerifier; merkleProof?: MerkleProof | null; ledger?: AnchorChecker } = {},
): Promise<VerifyResult> {
  const r = {
    report_hash: verifyReportHash(por),
    leaf_digest: verifyLeafDigest(por),
    evidence: true,
    merkle: true,
    chain_anchor: true,
  };
  if (opts.store) r.evidence = await opts.store.verify(por.evidence_cid);
  if (opts.merkleProof) {
    r.merkle = verifyMerkleInclusion(opts.merkleProof, por.leaf_digest);
    if (opts.ledger) {
      try {
        r.chain_anchor = await opts.ledger.isRootAnchored(opts.merkleProof.root_hex);
      } catch {
        r.chain_anchor = false;
      }
    }
  }
  return { ...r, all_ok: Object.values(r).every(Boolean) };
}
