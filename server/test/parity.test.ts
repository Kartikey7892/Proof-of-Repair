/**
 * Byte-for-byte parity with the original Python implementation.
 * Vectors come from test/fixtures/gen_parity.py (run against src/ Python code).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalDumps } from "../src/crypto/canonical.js";
import { MerkleTree, type MerkleProof } from "../src/crypto/merkle.js";
import { canonical, computeLeafDigest, reportHash, type ProofOfRepair } from "../src/por/proof.js";
import { verifyLeafDigest, verifyReportHash } from "../src/por/verify.js";

interface Vectors {
  canonical: { input: unknown; python: string }[];
  indent2: { input: unknown; python: string }[];
  proofs: { proof: ProofOfRepair; report_canonical: string }[];
  merkle: { leaves: string[]; root: string; proofs: MerkleProof[] }[];
}
const vectors: Vectors = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));

describe("canonical JSON matches Python json.dumps(sort_keys=True)", () => {
  vectors.canonical.forEach((c, i) =>
    it(`compact case ${i}`, () => {
      // The float-array case holds Python floats; everything else is typed by value.
      expect(canonicalDumps(c.input, { floatKeys: new Set(["floats"]) })).toBe(c.python);
    }),
  );
  vectors.indent2.forEach((c, i) =>
    it(`indent=2 case ${i}`, () => expect(canonicalDumps(c.input, { indent: 2 })).toBe(c.python)),
  );
});

describe("proof hashes match Python", () => {
  vectors.proofs.forEach((v, i) =>
    it(`proof ${i}`, () => {
      const proof = v.proof;
      expect(canonical(proof.report)).toBe(v.report_canonical);
      expect(reportHash(proof.report)).toBe(proof.report_hash);
      expect(computeLeafDigest(proof)).toBe(proof.leaf_digest);
      expect(verifyReportHash(proof)).toBe(true);
      expect(verifyLeafDigest(proof)).toBe(true);
    }),
  );
});

describe("Merkle tree matches Python", () => {
  vectors.merkle.forEach((m) =>
    it(`${m.leaves.length} leaves`, () => {
      const tree = MerkleTree.fromHex(m.leaves);
      expect(tree.rootHex).toBe(m.root);
      m.proofs.forEach((p, i) => {
        expect(tree.getProof(i)).toEqual(p);
        expect(MerkleTree.verifyProof(p)).toBe(true);
      });
    }),
  );
});
