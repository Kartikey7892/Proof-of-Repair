/**
 * Deterministic binary Merkle tree for Proof-of-Repair leaf digests.
 * Byte-compatible with src/blockchain/merkle.py (RSP / OpenTimestamps style):
 *   leaf = H(0x00 || payload), node = H(0x01 || left || right),
 *   odd nodes are paired with themselves.
 */
import { createHash } from "node:crypto";

export function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function leafHash(payload: Uint8Array): Buffer {
  return sha256(Buffer.concat([Buffer.from([0x00]), payload]));
}

function pairHash(left: Uint8Array, right: Uint8Array): Buffer {
  return sha256(Buffer.concat([Buffer.from([0x01]), left, right]));
}

export interface MerkleProof {
  leaf_index: number;
  leaf_hash_hex: string;
  siblings: string[];
  root_hex: string;
}

export class MerkleTree {
  readonly leaves: Buffer[];
  readonly levels: Buffer[][];

  constructor(leaves: Uint8Array[]) {
    if (leaves.length === 0) throw new Error("MerkleTree requires at least one leaf");
    this.leaves = leaves.map((l) => Buffer.from(l));
    this.levels = [this.leaves];
    let current = this.leaves;
    while (current.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i]!;
        const right = current[i + 1] ?? left;
        next.push(pairHash(left, right));
      }
      this.levels.push(next);
      current = next;
    }
  }

  static fromHex(leafDigestsHex: string[]): MerkleTree {
    return new MerkleTree(leafDigestsHex.map((h) => Buffer.from(h, "hex")));
  }

  get rootHex(): string {
    return this.levels[this.levels.length - 1]![0]!.toString("hex");
  }

  getProof(index: number): MerkleProof {
    if (index < 0 || index >= this.leaves.length) throw new RangeError("leaf index out of range");
    const siblings: string[] = [];
    let idx = index;
    for (const level of this.levels.slice(0, -1)) {
      const sib = idx % 2 === 0 ? (idx + 1 < level.length ? idx + 1 : idx) : idx - 1;
      siblings.push(level[sib]!.toString("hex"));
      idx = Math.floor(idx / 2);
    }
    return {
      leaf_index: index,
      leaf_hash_hex: this.leaves[index]!.toString("hex"),
      siblings,
      root_hex: this.rootHex,
    };
  }

  static verifyProof(proof: MerkleProof): boolean {
    let current: Buffer = Buffer.from(proof.leaf_hash_hex, "hex");
    let idx = proof.leaf_index;
    for (const sibHex of proof.siblings) {
      const sib = Buffer.from(sibHex, "hex");
      current = idx % 2 === 0 ? pairHash(current, sib) : pairHash(sib, current);
      idx = Math.floor(idx / 2);
    }
    return current.toString("hex") === proof.root_hex;
  }
}
