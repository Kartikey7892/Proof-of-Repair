"""SQLite VIN registry tests."""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.cloud.registry import VinRegistry


def test_sqlite_vin_timeline_and_anchor(tmp_path):
    db = VinRegistry(tmp_path / "por.sqlite3")
    por = {
        "proof_id": "p1",
        "vin": "1hgbh41jxmn109186",
        "vehicle": "2016 Honda Civic",
        "odometer_km": 98000,
        "event_type": "REPAIR",
        "issuer_id": "bay-1",
        "timestamp": time.time(),
        "leaf_digest": "ab" * 32,
        "report_hash": "cd" * 32,
        "evidence_cid": "ef" * 32,
        "report": {
            "fault_code": "P0420",
            "severity": "medium",
            "diagnosis": "catalyst efficiency",
            "parts": ["O2 sensor"],
            "buyer_advice": "ask for invoice",
        },
        "model": {"model_version": "test"},
        "extra": {},
    }
    db.upsert_proof(por)
    tl = db.vin_timeline("1HGBH41JXMN109186")
    assert tl["count"] == 1
    assert tl["trust_summary"] == "sealed_only"
    assert tl["timeline"][0]["fault_code"] == "P0420"

    db.save_anchor(
        batch_id="b1",
        merkle_root="11" * 32,
        leaf_digests=[por["leaf_digest"]],
        ots_receipt={"receipt_id": "ots-1", "status": "pending", "mode": "live_ots"},
        chain_tx={"tx_hash": "0xabc", "network": "hardhat-local", "mode": "live_evm"},
    )
    tl2 = db.vin_timeline("1HGBH41JXMN109186")
    assert tl2["trust_summary"] == "verified_timeline"
    assert tl2["timeline"][0]["anchored"] is True
    assert db.stats()["backend"] == "sqlite"
    assert db.get_proof("p1")["anchor"]["merkle_root"] == "11" * 32
