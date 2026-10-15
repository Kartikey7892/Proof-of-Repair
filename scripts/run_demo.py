#!/usr/bin/env python3
"""Production-style E2E: real LoRA model → PoR → Merkle → OTS/EVM → verify (vehicles)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.blockchain.anchoring import AnchoringService
from src.blockchain.ledger import InMemoryLedger
from src.cloud.storage import EvidenceStore
from src.por.proof import EventType, ModelProvenance, build_proof
from src.por.verify import verify_full

CASES = [
    {
        "vin": "1HGBH41JXMN109186",
        "vehicle": "2016 Honda Civic",
        "odometer_km": 98000,
        "dtc_codes": "P0420",
        "symptoms": "Check engine light on, failed emissions, slight sulfur smell from exhaust",
        "sensor_notes": "STFT/LTFT near trim limits; rear O2 voltage lazy",
    },
    {
        "vin": "4T1BF1FK5EU123456",
        "vehicle": "2015 Toyota Camry",
        "odometer_km": 142000,
        "dtc_codes": "P0300",
        "symptoms": "Rough idle and random misfire under load after cold start",
        "sensor_notes": "misfire counts rising on cylinders 2 and 4",
    },
    {
        "vin": "1FTEW1EP5JFA00001",
        "vehicle": "2018 Ford F-150",
        "odometer_km": 87000,
        "dtc_codes": "C0031",
        "symptoms": "ABS light on; traction control disabled after wet roads",
        "sensor_notes": "left front wheel speed intermittent",
    },
]


def _pick_engine(name: str):
    mistral_adapter = ROOT / "artifacts" / "adapters" / "mistral-mlx-lora"
    tiny_dtc = ROOT / "artifacts" / "adapters" / "vehicle-lora-dtc"
    tiny_adapter = ROOT / "artifacts" / "adapters" / "vehicle-lora"

    if name == "auto":
        if (mistral_adapter / "adapters.safetensors").exists():
            name = "mistral"
        elif (tiny_dtc / "adapter_config.json").exists():
            name = "tinyllama"
            # prefer paper DTC adapter
        elif (tiny_adapter / "adapter_config.json").exists():
            name = "tinyllama"
        else:
            raise SystemExit(
                "No trained adapter found. Train TinyLlama or Mistral first "
                "(see scripts/train_paper_dtc.sh / train_mistral_mlx.sh)."
            )

    if name == "mistral":
        from src.llm.mistral_mlx_infer import MistralMLXEngine

        if not (mistral_adapter / "adapters.safetensors").exists():
            raise SystemExit(f"Missing Mistral adapter at {mistral_adapter}")
        return MistralMLXEngine(adapter_path=mistral_adapter)

    from src.llm.infer import DiagnosticEngine

    adapter = tiny_dtc if (tiny_dtc / "adapter_config.json").exists() else tiny_adapter
    if not (adapter / "adapter_config.json").exists():
        raise SystemExit(
            "Missing TinyLlama adapter. Run:\n"
            "  bash scripts/train_paper_dtc.sh"
        )
    return DiagnosticEngine(adapter_dir=adapter)


def main() -> None:
    parser = argparse.ArgumentParser(description="VIN Proof-of-Repair live demo")
    parser.add_argument(
        "--engine",
        choices=("auto", "mistral", "tinyllama"),
        default="auto",
        help="Diagnosis backend (default: auto → Mistral MLX if present)",
    )
    args = parser.parse_args()

    engine = _pick_engine(args.engine)
    store = EvidenceStore(ROOT / "artifacts" / "evidence")
    ledger = InMemoryLedger()
    anchoring = AnchoringService(ledger=ledger)

    print("=" * 72)
    print("Second-Hand Vehicle Proof of Repair — Live Model Run")
    print(f"Model: {engine.model_name} @ {engine.model_version}")
    print(f"Adapter hash: {(engine.adapter_hash or '')[:16]}…")
    print("=" * 72)

    proofs = []
    for case in CASES:
        report = engine.diagnose(
            vehicle=case["vehicle"],
            symptoms=case["symptoms"],
            dtc_codes=case["dtc_codes"],
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
            odometer_km=case["odometer_km"],
            report=report,
            evidence_cid=cid,
            model=model,
            event_type=EventType.REPAIR,
            extra={"audience": "second_hand_buyer"},
        )
        proofs.append(por)
        print(f"\nVIN {case['vin']} | {case['vehicle']}")
        print(f"  DTC in         : {case['dtc_codes']}")
        print(f"  fault_code out : {report.fault_code}")
        print(f"  severity       : {report.severity}")
        print(f"  evidence_cid   : {cid[:18]}…")
        print(f"  leaf_digest    : {por.leaf_digest[:18]}…")
        if report.buyer_advice:
            print(f"  buyer_advice   : {report.buyer_advice[:120]}…")

    batch = anchoring.anchor_batch(
        [p.leaf_digest for p in proofs],
        batch_id="used-car-batch-mistral-001",
        meta_uri="artifacts/vehicle_batch_manifest.json",
    )
    manifest = {
        "batch_id": batch["batch_id"],
        "merkle_root": batch["merkle_root"],
        "ots_receipt": batch["ots_receipt"],
        "chain_tx": batch["chain_tx"],
        "proofs": [p.to_dict() for p in proofs],
        "merkle_proofs": batch["proofs"],
        "model": {
            "name": engine.model_name,
            "version": engine.model_version,
            "adapter_hash": engine.adapter_hash,
        },
    }
    out = ROOT / "artifacts" / "vehicle_batch_manifest.json"
    out.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print("\n" + "-" * 72)
    print(f"Merkle root : {batch['merkle_root']}")
    print(f"OTS receipt : {batch['ots_receipt']['receipt_id']}")
    print(f"Chain tx    : {batch['chain_tx']['tx_hash']}")

    print("\nVerification for used-car buyer:")
    ok = True
    for i, por in enumerate(proofs):
        result = verify_full(
            por, store=store, merkle_proof=batch["proofs"][str(i)], ledger=ledger
        )
        print(f"  {por.vin}: {result}")
        ok = ok and result["all_ok"]

    # Tamper detection
    proofs[0].report = dict(proofs[0].report)
    proofs[0].report["fault_code"] = "TAMPERED"
    tamper = verify_full(
        proofs[0], store=store, merkle_proof=batch["proofs"]["0"], ledger=ledger
    )
    print(f"\nTamper check (must fail report_hash): {tamper}")
    print("=" * 72)
    print("PASSED" if ok and not tamper["report_hash"] else "FAILED")
    print(f"Manifest → {out}")


if __name__ == "__main__":
    main()
