#!/usr/bin/env python3
"""Production-style end-to-end: real LoRA model → VIN PoR → Merkle → OTS + chain → verify."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.blockchain.anchoring import AnchoringService
from src.blockchain.ledger import InMemoryLedger
from src.cloud.storage import EvidenceStore
from src.llm.infer import DiagnosticEngine
from src.por.proof import EventType, ModelProvenance, build_proof
from src.por.verify import verify_full


CASES = [
    {
        "vin": "4T1BF1FK5FU123456",
        "vehicle": "2015 Toyota Camry",
        "dtc_code": "P0420",
        "symptoms": "Check engine light; failed emissions; rattling from exhaust area",
        "sensor_notes": "STFT/LTFT elevated; cat efficiency below threshold",
        "odometer_km": 142000,
    },
    {
        "vin": "19XFC2F59GE123456",
        "vehicle": "2016 Honda Civic",
        "dtc_code": "P0300",
        "symptoms": "Rough idle, occasional misfire under load",
        "sensor_notes": "misfire counters rising on multiple cylinders",
        "odometer_km": 98000,
    },
    {
        "vin": "1FTEW1EP5JFA12345",
        "vehicle": "2018 Ford F-150",
        "dtc_code": "C0031",
        "symptoms": "ABS light on; intermittent traction control warning",
        "sensor_notes": "left front wheel speed signal dropouts",
        "odometer_km": 87000,
    },
]


def main() -> None:
    store = EvidenceStore(ROOT / "artifacts" / "evidence")
    ledger = InMemoryLedger()
    anchoring = AnchoringService(ledger=ledger)
    engine = DiagnosticEngine()

    proofs = []
    print("=" * 72)
    print("Second-Hand Vehicle Proof of Repair — Live Model Run")
    print(f"Model: {engine.model_name} / {engine.model_version}")
    print(f"Adapter hash: {engine.adapter_hash[:16]}…")
    print("=" * 72)

    for case in CASES:
        report = engine.diagnose(
            vehicle=case["vehicle"],
            vin=case["vin"],
            dtc_code=case["dtc_code"],
            symptoms=case["symptoms"],
            sensor_notes=case["sensor_notes"],
        )
        evidence = {**case, "report": report.to_dict()}
        cid = store.put_json(evidence, meta={"type": "vehicle_repair_evidence"})
        model = ModelProvenance(
            model_name=engine.model_name,
            model_version=engine.model_version,
            adapter_hash=engine.adapter_hash,
            dataset_merkle_root=engine.dataset_merkle_root,
        )
        por = build_proof(
            vin=case["vin"],
            vehicle=case["vehicle"],
            report=report,
            evidence_cid=cid,
            model=model,
            odometer_km=case["odometer_km"],
            event_type=EventType.REPAIR,
            workshop_id="city-independent-motors",
        )
        proofs.append(por)
        print(f"\nVIN {case['vin']}")
        print(f"  vehicle      : {case['vehicle']}")
        print(f"  fault_code   : {report.fault_code}")
        print(f"  severity     : {report.severity}")
        print(f"  evidence_cid : {cid[:18]}…")
        print(f"  leaf_digest  : {por.leaf_digest[:18]}…")

    batch = anchoring.anchor_batch(
        [p.leaf_digest for p in proofs],
        batch_id="vehicle-batch-001",
        meta_uri="artifacts/vehicle_batch_manifest.json",
    )
    manifest = {
        "batch_id": batch["batch_id"],
        "merkle_root": batch["merkle_root"],
        "ots_receipt": batch["ots_receipt"],
        "chain_tx": batch["chain_tx"],
        "proofs": [p.to_dict() for p in proofs],
        "merkle_proofs": batch["proofs"],
        "audience": "second_hand_vehicle_buyers",
    }
    out = ROOT / "artifacts" / "vehicle_batch_manifest.json"
    out.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print("\n" + "-" * 72)
    print(f"Merkle root : {batch['merkle_root']}")
    print(f"Chain tx    : {batch['chain_tx']['tx_hash']}")

    print("\nVerification for buyer:")
    ok = True
    for i, por in enumerate(proofs):
        result = verify_full(
            por, store=store, merkle_proof=batch["proofs"][str(i)], ledger=ledger
        )
        print(f"  {por.vin}: all_ok={result['all_ok']} details={result}")
        ok = ok and result["all_ok"]

    print("\n" + ("PASSED" if ok else "FAILED"))
    print(f"Manifest → {out}")


if __name__ == "__main__":
    main()
