"""SQLite VIN attestation registry (app DB).

Keeps structured repair proofs queryable by VIN. Evidence blobs stay
content-addressed on disk; Merkle roots stay on chain / OTS.
Schema is intentionally Postgres-shaped for a later lift-and-shift.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


def norm_vin(vin: str) -> str:
    return (vin or "").strip().upper()


class VinRegistry:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS proofs (
                    proof_id TEXT PRIMARY KEY,
                    vin TEXT NOT NULL,
                    vehicle TEXT,
                    odometer_km INTEGER,
                    event_type TEXT,
                    issuer_id TEXT,
                    timestamp REAL,
                    leaf_digest TEXT,
                    report_hash TEXT,
                    evidence_cid TEXT,
                    fault_code TEXT,
                    severity TEXT,
                    diagnosis TEXT,
                    buyer_advice TEXT,
                    report_json TEXT NOT NULL,
                    model_json TEXT,
                    extra_json TEXT,
                    proof_json TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_proofs_vin ON proofs(vin);
                CREATE INDEX IF NOT EXISTS idx_proofs_leaf ON proofs(leaf_digest);
                CREATE INDEX IF NOT EXISTS idx_proofs_ts ON proofs(timestamp);

                CREATE TABLE IF NOT EXISTS anchors (
                    batch_id TEXT PRIMARY KEY,
                    merkle_root TEXT NOT NULL,
                    ots_receipt_id TEXT,
                    ots_status TEXT,
                    ots_mode TEXT,
                    chain_tx TEXT,
                    chain_network TEXT,
                    chain_mode TEXT,
                    meta_json TEXT,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_anchors_root ON anchors(merkle_root);

                CREATE TABLE IF NOT EXISTS proof_anchors (
                    proof_id TEXT NOT NULL,
                    batch_id TEXT NOT NULL,
                    PRIMARY KEY (proof_id, batch_id),
                    FOREIGN KEY (proof_id) REFERENCES proofs(proof_id),
                    FOREIGN KEY (batch_id) REFERENCES anchors(batch_id)
                );
                """
            )

    def upsert_proof(self, por: Dict[str, Any]) -> None:
        report = por.get("report") or {}
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO proofs (
                    proof_id, vin, vehicle, odometer_km, event_type, issuer_id,
                    timestamp, leaf_digest, report_hash, evidence_cid,
                    fault_code, severity, diagnosis, buyer_advice,
                    report_json, model_json, extra_json, proof_json, created_at
                ) VALUES (
                    :proof_id, :vin, :vehicle, :odometer_km, :event_type, :issuer_id,
                    :timestamp, :leaf_digest, :report_hash, :evidence_cid,
                    :fault_code, :severity, :diagnosis, :buyer_advice,
                    :report_json, :model_json, :extra_json, :proof_json, :created_at
                )
                ON CONFLICT(proof_id) DO UPDATE SET
                    vin=excluded.vin,
                    vehicle=excluded.vehicle,
                    odometer_km=excluded.odometer_km,
                    event_type=excluded.event_type,
                    issuer_id=excluded.issuer_id,
                    timestamp=excluded.timestamp,
                    leaf_digest=excluded.leaf_digest,
                    report_hash=excluded.report_hash,
                    evidence_cid=excluded.evidence_cid,
                    fault_code=excluded.fault_code,
                    severity=excluded.severity,
                    diagnosis=excluded.diagnosis,
                    buyer_advice=excluded.buyer_advice,
                    report_json=excluded.report_json,
                    model_json=excluded.model_json,
                    extra_json=excluded.extra_json,
                    proof_json=excluded.proof_json
                """,
                {
                    "proof_id": por["proof_id"],
                    "vin": norm_vin(por.get("vin", "")),
                    "vehicle": por.get("vehicle"),
                    "odometer_km": por.get("odometer_km"),
                    "event_type": por.get("event_type"),
                    "issuer_id": por.get("issuer_id"),
                    "timestamp": por.get("timestamp"),
                    "leaf_digest": por.get("leaf_digest"),
                    "report_hash": por.get("report_hash"),
                    "evidence_cid": por.get("evidence_cid"),
                    "fault_code": report.get("fault_code"),
                    "severity": report.get("severity"),
                    "diagnosis": report.get("diagnosis"),
                    "buyer_advice": report.get("buyer_advice"),
                    "report_json": json.dumps(report),
                    "model_json": json.dumps(por.get("model") or {}),
                    "extra_json": json.dumps(por.get("extra") or {}),
                    "proof_json": json.dumps(por),
                    "created_at": time.time(),
                },
            )

    def get_proof(self, proof_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT proof_json FROM proofs WHERE proof_id = ?", (proof_id,)
            ).fetchone()
        if not row:
            return None
        por = json.loads(row["proof_json"])
        anchor = self.latest_anchor_for_proof(proof_id)
        if anchor:
            por["anchor"] = anchor
        return por

    def list_proofs(self) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT proof_id, proof_json FROM proofs ORDER BY timestamp ASC"
            ).fetchall()
        out = []
        for row in rows:
            por = json.loads(row["proof_json"])
            anchor = self.latest_anchor_for_proof(row["proof_id"])
            if anchor:
                por["anchor"] = anchor
            out.append(por)
        return out

    def proofs_by_leaf(self, leaf_digests: Iterable[str]) -> List[Dict[str, Any]]:
        leaves = list(leaf_digests)
        if not leaves:
            return []
        placeholders = ",".join("?" * len(leaves))
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT proof_json FROM proofs WHERE leaf_digest IN ({placeholders})",
                leaves,
            ).fetchall()
        return [json.loads(r["proof_json"]) for r in rows]

    def save_anchor(
        self,
        batch_id: str,
        merkle_root: str,
        leaf_digests: List[str],
        ots_receipt: Optional[Dict[str, Any]] = None,
        chain_tx: Optional[Dict[str, Any]] = None,
        meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        ots = ots_receipt or {}
        chain = chain_tx if isinstance(chain_tx, dict) else {}
        anchor_meta = {
            "batch_id": batch_id,
            "merkle_root": merkle_root,
            "ots_receipt_id": ots.get("receipt_id"),
            "ots_status": ots.get("status"),
            "ots_mode": ots.get("mode"),
            "chain_tx": chain.get("tx_hash") if chain else (chain_tx if isinstance(chain_tx, str) else None),
            "chain_network": chain.get("network"),
            "chain_mode": chain.get("mode"),
        }
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO anchors (
                    batch_id, merkle_root, ots_receipt_id, ots_status, ots_mode,
                    chain_tx, chain_network, chain_mode, meta_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(batch_id) DO UPDATE SET
                    merkle_root=excluded.merkle_root,
                    ots_receipt_id=excluded.ots_receipt_id,
                    ots_status=excluded.ots_status,
                    ots_mode=excluded.ots_mode,
                    chain_tx=excluded.chain_tx,
                    chain_network=excluded.chain_network,
                    chain_mode=excluded.chain_mode,
                    meta_json=excluded.meta_json
                """,
                (
                    batch_id,
                    merkle_root,
                    anchor_meta["ots_receipt_id"],
                    anchor_meta["ots_status"],
                    anchor_meta["ots_mode"],
                    anchor_meta["chain_tx"],
                    anchor_meta["chain_network"],
                    anchor_meta["chain_mode"],
                    json.dumps({"leaf_order": leaf_digests, **(meta or {})}),
                    time.time(),
                ),
            )
            for leaf in leaf_digests:
                row = conn.execute(
                    "SELECT proof_id FROM proofs WHERE leaf_digest = ?", (leaf,)
                ).fetchone()
                if not row:
                    continue
                conn.execute(
                    """
                    INSERT OR IGNORE INTO proof_anchors (proof_id, batch_id)
                    VALUES (?, ?)
                    """,
                    (row["proof_id"], batch_id),
                )
                # Keep embedded anchor on proof_json for API convenience
                por_row = conn.execute(
                    "SELECT proof_json FROM proofs WHERE proof_id = ?",
                    (row["proof_id"],),
                ).fetchone()
                if por_row:
                    por = json.loads(por_row["proof_json"])
                    por["anchor"] = anchor_meta
                    conn.execute(
                        "UPDATE proofs SET proof_json = ? WHERE proof_id = ?",
                        (json.dumps(por), row["proof_id"]),
                    )
        return anchor_meta

    def latest_anchor_for_proof(self, proof_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT a.* FROM anchors a
                JOIN proof_anchors pa ON pa.batch_id = a.batch_id
                WHERE pa.proof_id = ?
                ORDER BY a.created_at DESC
                LIMIT 1
                """,
                (proof_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "batch_id": row["batch_id"],
            "merkle_root": row["merkle_root"],
            "ots_receipt_id": row["ots_receipt_id"],
            "ots_status": row["ots_status"],
            "ots_mode": row["ots_mode"],
            "chain_tx": row["chain_tx"],
            "chain_network": row["chain_network"],
            "chain_mode": row["chain_mode"],
        }

    def vin_timeline(self, vin: str) -> Dict[str, Any]:
        vin_n = norm_vin(vin)
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT proof_id, proof_json FROM proofs
                WHERE vin = ?
                ORDER BY timestamp ASC
                """,
                (vin_n,),
            ).fetchall()
        timeline = []
        for row in rows:
            p = json.loads(row["proof_json"])
            report = p.get("report") or {}
            anchor = p.get("anchor") or self.latest_anchor_for_proof(row["proof_id"]) or {}
            timeline.append(
                {
                    "proof_id": p.get("proof_id"),
                    "when": p.get("timestamp"),
                    "vehicle": p.get("vehicle"),
                    "odometer_km": p.get("odometer_km"),
                    "issuer_id": p.get("issuer_id"),
                    "event_type": p.get("event_type"),
                    "fault_code": report.get("fault_code"),
                    "severity": report.get("severity"),
                    "diagnosis": report.get("diagnosis"),
                    "parts": report.get("parts") or [],
                    "buyer_advice": report.get("buyer_advice"),
                    "leaf_digest": p.get("leaf_digest"),
                    "evidence_cid": p.get("evidence_cid"),
                    "anchored": bool(anchor.get("merkle_root")),
                    "anchor": anchor,
                }
            )
        return {
            "vin": vin_n,
            "count": len(timeline),
            "anchored_count": sum(1 for e in timeline if e["anchored"]),
            "timeline": timeline,
            "trust_summary": (
                "verified_timeline"
                if timeline and all(e["anchored"] for e in timeline)
                else "partial"
                if any(e["anchored"] for e in timeline)
                else "sealed_only"
                if timeline
                else "empty"
            ),
            "storage": "sqlite",
        }

    def stats(self) -> Dict[str, Any]:
        with self._connect() as conn:
            proofs = conn.execute("SELECT COUNT(*) AS n FROM proofs").fetchone()["n"]
            vins = conn.execute("SELECT COUNT(DISTINCT vin) AS n FROM proofs").fetchone()["n"]
            anchors = conn.execute("SELECT COUNT(*) AS n FROM anchors").fetchone()["n"]
        return {
            "backend": "sqlite",
            "path": str(self.db_path),
            "proofs": proofs,
            "vins": vins,
            "anchors": anchors,
            "note": "Postgres-shaped schema; evidence blobs remain content-addressed files",
        }

    def migrate_jsonl(self, registry_dir: str | Path) -> int:
        """Import legacy artifacts/vin_registry/*.jsonl if present."""
        root = Path(registry_dir)
        if not root.exists():
            return 0
        imported = 0
        for path in sorted(root.glob("*.jsonl")):
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    por = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not por.get("proof_id"):
                    continue
                self.upsert_proof(por)
                imported += 1
                anchor = por.get("anchor")
                if anchor and anchor.get("merkle_root") and por.get("leaf_digest"):
                    batch_id = anchor.get("batch_id") or f"migrated-{por['proof_id'][:8]}"
                    self.save_anchor(
                        batch_id=batch_id,
                        merkle_root=anchor["merkle_root"],
                        leaf_digests=[por["leaf_digest"]],
                        ots_receipt={
                            "receipt_id": anchor.get("ots_receipt_id"),
                            "status": anchor.get("ots_status"),
                            "mode": anchor.get("ots_mode"),
                        },
                        chain_tx={
                            "tx_hash": anchor.get("chain_tx"),
                            "network": anchor.get("chain_network"),
                            "mode": anchor.get("chain_mode"),
                        },
                    )
        return imported
