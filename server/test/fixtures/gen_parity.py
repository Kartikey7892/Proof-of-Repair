"""Generate Python reference vectors for the Node crypto port.

Run from the repo root:  python server/test/fixtures/gen_parity.py
Writes server/test/fixtures/parity.json. The Node test-suite asserts byte-for-byte
equality against these, so proofs sealed by either backend verify in the other.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from src.blockchain.merkle import MerkleTree, leaf_hash  # noqa: E402
from src.por.proof import ProofOfRepair, canonical_dumps, sha256_hex  # noqa: E402

canonical_cases = [
    {"b": 1, "a": [3, 2, 1], "c": {"z": None, "y": True, "x": False}},
    {"text": "Café ✓ naïve — 東京 🚗", "ctrl": "tab\there\nnl\r\u0001\u007f", "q": 'say "hi" \\ ok'},
    {"floats": [0.1, 0.7, 1.5, 123.456, 1e-05, 0.0001, 1e16, 1.5e16, 1234567890123456.7, -0.25]},
    {"ints": [0, -1, 98000, 9007199254740991]},
    {"empty_obj": {}, "empty_list": [], "empty_str": ""},
]

reports = [
    {
        "fault_code": "P0420",
        "diagnosis": "catalyst efficiency below threshold",
        "severity": "medium",
        "parts": ["catalytic_converter"],
        "repair_steps": ["test O2 sensors", "replace catalyst if needed"],
        "qa_checks": ["readiness_monitors_ready"],
        "estimated_minutes": 120,
        "confidence": 0.88,
        "buyer_advice": "Ask for post-repair emissions proof",
    },
    {
        "fault_code": "C0031",
        "diagnosis": "ABS wheel-speed circuit — sensor/tone ring",
        "severity": "high",
        "parts": [],
        "repair_steps": ["Scan ABS module"],
        "qa_checks": [],
        "estimated_minutes": 75,
        "confidence": 1.0,  # integral float: Python emits 1.0, JS would emit 1
        "buyer_advice": "",
    },
    {
        "fault_code": "P0300",
        "diagnosis": "random misfire",
        "severity": "low",
        "parts": ["ignition_coil"],
        "repair_steps": ["replace coils"],
        "qa_checks": ["no_misfire"],
        "estimated_minutes": 60,
        "confidence": 0.0,
        "buyer_advice": "Request invoice",
    },
]

proofs = []
for i, (report, ts) in enumerate(
    zip(reports, [1734567890.123456, 1700000000.0, 1760000000.5])
):
    por = ProofOfRepair(
        proof_id=f"00000000-0000-4000-8000-00000000000{i}",
        vin="1HGBH41JXMN109186",
        vehicle="2016 Honda Civic",
        odometer_km=98000 + i,
        event_type="REPAIR",
        issuer_id="certified-workshop",
        timestamp=ts,
        report=report,
        evidence_cid="ab" * 32,
        report_hash=sha256_hex(canonical_dumps(report)),
        model={
            "model_name": "peft:TinyLlama/TinyLlama-1.1B-Chat-v1.0",
            "model_version": "vehicle-lora-v2",
            "adapter_hash": "cd" * 32,
            "dataset_merkle_root": "",
            "framework": "transformers+peft",
        },
        extra={"audience": "second_hand_buyer", "engine": "tinyllama"},
    )
    por.compute_leaf_digest()
    proofs.append(
        {
            "proof": por.to_dict(),
            "report_canonical": canonical_dumps(report),
            "leaf_payload_canonical": canonical_dumps(por.payload_for_leaf()),
        }
    )

merkle = []
for n in range(1, 8):
    leaves = [leaf_hash(f"leaf-{i}".encode()) for i in range(n)]
    tree = MerkleTree(leaves)
    merkle.append(
        {
            "leaves": [x.hex() for x in leaves],
            "root": tree.root_hex,
            "proofs": [
                {
                    "leaf_index": p.leaf_index,
                    "leaf_hash_hex": p.leaf_hash_hex,
                    "siblings": list(p.siblings),
                    "root_hex": p.root_hex,
                }
                for p in (tree.get_proof(i) for i in range(n))
            ],
        }
    )

out = {
    "canonical": [{"input": c, "python": canonical_dumps(c)} for c in canonical_cases],
    "indent2": [
        {"input": c, "python": json.dumps(c, sort_keys=True, indent=2)} for c in canonical_cases[:2]
    ],
    "proofs": proofs,
    "merkle": merkle,
}
dest = Path(__file__).with_name("parity.json")
dest.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
print(f"wrote {dest}")
