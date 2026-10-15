"""Independent verification of vehicle Proof-of-Repair objects."""

from __future__ import annotations

from typing import Any, Dict, Optional

from src.blockchain.merkle import MerkleProof, MerkleTree
from src.cloud.storage import EvidenceStore
from src.por.proof import ProofOfRepair, canonical_dumps, sha256_hex


def verify_report_hash(por: ProofOfRepair) -> bool:
    return sha256_hex(canonical_dumps(por.report)) == por.report_hash


def verify_leaf_digest(por: ProofOfRepair) -> bool:
    expected = por.leaf_digest
    recomputed = ProofOfRepair(
        proof_id=por.proof_id,
        vin=por.vin,
        vehicle=por.vehicle,
        odometer_km=por.odometer_km,
        event_type=por.event_type,
        issuer_id=por.issuer_id,
        timestamp=por.timestamp,
        report=por.report,
        evidence_cid=por.evidence_cid,
        report_hash=por.report_hash,
        model=por.model,
        extra=por.extra,
    ).compute_leaf_digest()
    return expected == recomputed


def verify_evidence(store: EvidenceStore, cid: str) -> bool:
    return store.verify(cid)


def verify_merkle_inclusion(proof_dict: Dict[str, Any], leaf_digest_hex: str) -> bool:
    proof = MerkleProof(
        leaf_index=int(proof_dict["leaf_index"]),
        leaf_hash_hex=proof_dict["leaf_hash_hex"],
        siblings=tuple(proof_dict["siblings"]),
        root_hex=proof_dict["root_hex"],
    )
    if proof.leaf_hash_hex != leaf_digest_hex:
        return False
    return MerkleTree.verify_proof(proof)


def verify_full(
    por: ProofOfRepair,
    store: Optional[EvidenceStore] = None,
    merkle_proof: Optional[Dict[str, Any]] = None,
    ledger=None,
) -> Dict[str, bool]:
    results = {
        "report_hash": verify_report_hash(por),
        "leaf_digest": verify_leaf_digest(por),
        "evidence": True,
        "merkle": True,
        "chain_anchor": True,
    }
    if store is not None:
        results["evidence"] = verify_evidence(store, por.evidence_cid)
    if merkle_proof is not None:
        results["merkle"] = verify_merkle_inclusion(merkle_proof, por.leaf_digest)
        if ledger is not None:
            results["chain_anchor"] = ledger.is_root_anchored(merkle_proof["root_hex"])
    results["all_ok"] = all(results.values())
    return results
