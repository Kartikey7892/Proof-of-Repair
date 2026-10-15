"""In-memory EVM-style ledger mirroring ProofOfRepair.sol behaviour."""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional


@dataclass
class AnchorRecord:
    merkle_root: str
    batch_id: str
    meta_uri: str
    submitter: str
    anchored_at: float
    tx_hash: str


class InMemoryLedger:
    """Simulates the ProofOfRepair smart contract without requiring a live chain."""

    def __init__(self, submitter: str = "0xCloudPoRService"):
        self.submitter = submitter
        self.anchors: Dict[str, AnchorRecord] = {}
        self.batch_root: Dict[str, str] = {}

    def anchor_merkle_root(
        self, root_hex: str, batch_id: str, meta_uri: str = ""
    ) -> Dict[str, Any]:
        if not root_hex or root_hex == "0" * 64:
            raise ValueError("empty root")
        if root_hex in self.anchors:
            raise ValueError("root already anchored")
        if batch_id in self.batch_root:
            raise ValueError("batch already used")

        tx_hash = "0x" + uuid.uuid4().hex
        record = AnchorRecord(
            merkle_root=root_hex,
            batch_id=batch_id,
            meta_uri=meta_uri,
            submitter=self.submitter,
            anchored_at=time.time(),
            tx_hash=tx_hash,
        )
        self.anchors[root_hex] = record
        self.batch_root[batch_id] = root_hex
        return asdict(record)

    def is_root_anchored(self, root_hex: str) -> bool:
        return root_hex in self.anchors

    def get_anchor(self, root_hex: str) -> Optional[Dict[str, Any]]:
        rec = self.anchors.get(root_hex)
        return asdict(rec) if rec else None
