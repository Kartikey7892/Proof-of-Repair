"""Proof of Repair for second-hand vehicles — VIN-bound repair attestation."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class EventType(str, Enum):
    DIAGNOSIS = "DIAGNOSIS"
    REPAIR = "REPAIR"
    PARTS_REPLACE = "PARTS_REPLACE"
    PPI_PASS = "PPI_PASS"  # pre-purchase inspection
    OBD_CLEAR = "OBD_CLEAR"


def canonical_dumps(obj: Dict[str, Any]) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def sha256_hex(text: str | bytes) -> str:
    if isinstance(text, str):
        text = text.encode("utf-8")
    return hashlib.sha256(text).hexdigest()


@dataclass
class ModelProvenance:
    model_name: str
    model_version: str
    adapter_hash: str = ""
    dataset_merkle_root: str = ""
    framework: str = "transformers+peft"

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class RepairReport:
    fault_code: str
    diagnosis: str
    severity: str
    parts: List[str]
    repair_steps: List[str]
    qa_checks: List[str]
    estimated_minutes: int
    confidence: float = 0.0
    buyer_advice: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RepairReport":
        return cls(
            fault_code=str(data["fault_code"]),
            diagnosis=str(data["diagnosis"]),
            severity=str(data["severity"]),
            parts=list(data.get("parts", [])),
            repair_steps=list(data.get("repair_steps", [])),
            qa_checks=list(data.get("qa_checks", [])),
            estimated_minutes=int(data.get("estimated_minutes", 0)),
            confidence=float(data.get("confidence", 0.0)),
            buyer_advice=str(data.get("buyer_advice", "")),
        )


@dataclass
class ProofOfRepair:
    proof_id: str
    vin: str
    vehicle: str  # year make model
    odometer_km: int
    event_type: str
    issuer_id: str  # workshop / inspector
    timestamp: float
    report: Dict[str, Any]
    evidence_cid: str
    report_hash: str
    model: Dict[str, Any]
    leaf_digest: str = ""
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def payload_for_leaf(self) -> Dict[str, Any]:
        return {
            "proof_id": self.proof_id,
            "vin": self.vin,
            "vehicle": self.vehicle,
            "odometer_km": self.odometer_km,
            "event_type": self.event_type,
            "issuer_id": self.issuer_id,
            "timestamp": self.timestamp,
            "report_hash": self.report_hash,
            "evidence_cid": self.evidence_cid,
            "model": self.model,
            "extra": self.extra,
        }

    def compute_leaf_digest(self) -> str:
        payload = canonical_dumps(self.payload_for_leaf()).encode("utf-8")
        digest = hashlib.sha256(b"\x00" + payload).hexdigest()
        self.leaf_digest = digest
        return digest


def build_proof(
    vin: str,
    vehicle: str,
    odometer_km: int,
    report: RepairReport,
    evidence_cid: str,
    model: ModelProvenance,
    issuer_id: str = "certified-workshop",
    event_type: EventType = EventType.REPAIR,
    extra: Optional[Dict[str, Any]] = None,
) -> ProofOfRepair:
    report_dict = report.to_dict()
    report_hash = sha256_hex(canonical_dumps(report_dict))
    por = ProofOfRepair(
        proof_id=str(uuid.uuid4()),
        vin=vin.upper(),
        vehicle=vehicle,
        odometer_km=int(odometer_km),
        event_type=event_type.value,
        issuer_id=issuer_id,
        timestamp=time.time(),
        report=report_dict,
        evidence_cid=evidence_cid,
        report_hash=report_hash,
        model=model.to_dict(),
        extra=extra or {},
    )
    por.compute_leaf_digest()
    return por
