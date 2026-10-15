"""Deterministic Merkle tree for Proof-of-Repair leaf digests.

Follows RSP / OpenTimestamps style binary Merkle trees (P4, P8).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence, Tuple


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_bytes(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def _pair_hash(left: bytes, right: bytes) -> bytes:
    # Domain-separated node hash: H(0x01 || left || right)
    return sha256_bytes(b"\x01" + left + right)


def leaf_hash(payload: bytes) -> bytes:
    # Domain-separated leaf hash: H(0x00 || payload)
    return sha256_bytes(b"\x00" + payload)


@dataclass(frozen=True)
class MerkleProof:
    leaf_index: int
    leaf_hash_hex: str
    siblings: Tuple[str, ...]  # hex hashes from leaf toward root
    root_hex: str


class MerkleTree:
    """Binary Merkle tree over an ordered list of pre-hashed leaves (32-byte digests)."""

    def __init__(self, leaves: Sequence[bytes]):
        if not leaves:
            raise ValueError("MerkleTree requires at least one leaf")
        self.leaves: List[bytes] = [bytes(x) for x in leaves]
        self.levels: List[List[bytes]] = self._build(self.leaves)

    @staticmethod
    def _build(leaves: List[bytes]) -> List[List[bytes]]:
        levels: List[List[bytes]] = [list(leaves)]
        current = list(leaves)
        while len(current) > 1:
            nxt: List[bytes] = []
            for i in range(0, len(current), 2):
                left = current[i]
                right = current[i + 1] if i + 1 < len(current) else current[i]
                nxt.append(_pair_hash(left, right))
            levels.append(nxt)
            current = nxt
        return levels

    @property
    def root(self) -> bytes:
        return self.levels[-1][0]

    @property
    def root_hex(self) -> str:
        return self.root.hex()

    def get_proof(self, index: int) -> MerkleProof:
        if index < 0 or index >= len(self.leaves):
            raise IndexError("leaf index out of range")
        siblings: List[str] = []
        idx = index
        for level in self.levels[:-1]:
            if idx % 2 == 0:
                sibling_idx = idx + 1 if idx + 1 < len(level) else idx
            else:
                sibling_idx = idx - 1
            siblings.append(level[sibling_idx].hex())
            idx //= 2
        return MerkleProof(
            leaf_index=index,
            leaf_hash_hex=self.leaves[index].hex(),
            siblings=tuple(siblings),
            root_hex=self.root_hex,
        )

    @staticmethod
    def verify_proof(proof: MerkleProof, leaf_digest: Optional[bytes] = None) -> bool:
        current = leaf_digest if leaf_digest is not None else bytes.fromhex(proof.leaf_hash_hex)
        if current.hex() != proof.leaf_hash_hex:
            return False
        idx = proof.leaf_index
        for sib_hex in proof.siblings:
            sibling = bytes.fromhex(sib_hex)
            if idx % 2 == 0:
                current = _pair_hash(current, sibling)
            else:
                current = _pair_hash(sibling, current)
            idx //= 2
        return current.hex() == proof.root_hex


def merkle_root_from_payloads(payloads: Iterable[bytes]) -> Tuple[str, MerkleTree]:
    leaves = [leaf_hash(p) for p in payloads]
    tree = MerkleTree(leaves)
    return tree.root_hex, tree
