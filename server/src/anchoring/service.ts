/** Batches PoR leaf digests into a Merkle root and anchors via OTS calendar + EVM ledger. */
import { MerkleTree, type MerkleProof } from "../crypto/merkle.js";
import type { Ledger } from "./ledger.js";
import type { Calendar, TimestampReceipt } from "./ots.js";

export interface AnchorResult {
  batch_id: string;
  merkle_root: string;
  ots_receipt: TimestampReceipt;
  chain_tx: Record<string, unknown> | null;
  proofs: MerkleProof[];
}

export class AnchoringService {
  constructor(
    readonly calendar: Calendar,
    readonly ledger: Ledger | null,
  ) {}

  async anchorBatch(leafDigestsHex: string[], batchId: string, metaUri = ""): Promise<AnchorResult> {
    if (!leafDigestsHex.length) throw new Error("empty batch");
    if (leafDigestsHex.some((h) => !/^[0-9a-f]{64}$/.test(h))) throw new Error("leaf digests must be 32-byte hex");
    const tree = MerkleTree.fromHex(leafDigestsHex);
    const root = tree.rootHex;
    const receipt = await this.calendar.submit(root);
    const chain_tx = this.ledger
      ? await this.ledger.anchorMerkleRoot(root, batchId, metaUri || `ots:${receipt.receipt_id}`)
      : null;
    return {
      batch_id: batchId,
      merkle_root: root,
      ots_receipt: receipt,
      chain_tx,
      proofs: leafDigestsHex.map((_, i) => tree.getProof(i)),
    };
  }
}
