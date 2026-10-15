"""Unit tests for vehicle PoR cryptography (model-independent)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.blockchain.anchoring import AnchoringService, LocalCalendar
from src.blockchain.ledger import InMemoryLedger
from src.blockchain.merkle import MerkleTree, leaf_hash
from src.cloud.storage import EvidenceStore
from src.por.proof import ModelProvenance, RepairReport, build_proof
from src.por.verify import verify_full, verify_leaf_digest, verify_report_hash


def test_merkle_inclusion_roundtrip():
    leaves = [leaf_hash(f"leaf-{i}".encode()) for i in range(5)]
    tree = MerkleTree(leaves)
    for i in range(5):
        proof = tree.get_proof(i)
        assert MerkleTree.verify_proof(proof)


def test_vehicle_por_hash_binding(tmp_path):
    store = EvidenceStore(tmp_path / "ev")
    report = RepairReport(
        fault_code="P0420",
        diagnosis="catalyst efficiency below threshold",
        severity="medium",
        parts=["catalytic_converter"],
        repair_steps=["test O2 sensors", "replace catalyst if needed"],
        qa_checks=["readiness_monitors_ready"],
        estimated_minutes=120,
        confidence=0.88,
        buyer_advice="Ask for post-repair emissions proof",
    )
    cid = store.put_json({"report": report.to_dict()})
    por = build_proof(
        vin="1HGBH41JXMN109186",
        vehicle="2016 Honda Civic",
        odometer_km=98000,
        report=report,
        evidence_cid=cid,
        model=ModelProvenance("peft:test", "1"),
    )
    assert verify_report_hash(por)
    assert verify_leaf_digest(por)
    por.report = dict(por.report)
    por.report["fault_code"] = "X"
    assert not verify_report_hash(por)


def test_anchor_and_verify(tmp_path):
    store = EvidenceStore(tmp_path / "ev")
    ledger = InMemoryLedger()
    anchoring = AnchoringService(calendar=LocalCalendar(tmp_path / "ots"), ledger=ledger)
    proofs = []
    for i in range(3):
        report = RepairReport(
            fault_code="P0300",
            diagnosis="random misfire",
            severity="high",
            parts=["ignition_coil"],
            repair_steps=["replace coils", "clear codes"],
            qa_checks=["no_misfire"],
            estimated_minutes=60,
            confidence=0.8,
            buyer_advice="Request invoice",
        )
        cid = store.put_json({"i": i, "report": report.to_dict()})
        por = build_proof(
            vin=f"VIN{i:014d}",
            vehicle="2015 Toyota Camry",
            odometer_km=100000 + i,
            report=report,
            evidence_cid=cid,
            model=ModelProvenance("peft:test", "1"),
        )
        proofs.append(por)
    batch = anchoring.anchor_batch([p.leaf_digest for p in proofs], batch_id="veh1")
    assert ledger.is_root_anchored(batch["merkle_root"])
    for i, por in enumerate(proofs):
        assert verify_full(
            por, store=store, merkle_proof=batch["proofs"][str(i)], ledger=ledger
        )["all_ok"]
