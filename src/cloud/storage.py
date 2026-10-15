"""Content-addressed cloud evidence store (IPFS-compatible abstraction)."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any, Dict, Optional, Union


class EvidenceStore:
    """Stores bytes under sha256 content ids. Mimics IPFS CID usage (P2, P3)."""

    def __init__(self, root: str | Path = "artifacts/evidence"):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.index_path = self.root / "index.json"
        if not self.index_path.exists():
            self._write_index({})

    def _write_index(self, data: Dict[str, Any]) -> None:
        self.index_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _read_index(self) -> Dict[str, Any]:
        return json.loads(self.index_path.read_text(encoding="utf-8"))

    @staticmethod
    def content_id(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def put_bytes(self, data: bytes, meta: Optional[Dict[str, Any]] = None) -> str:
        cid = self.content_id(data)
        path = self.root / cid
        if not path.exists():
            path.write_bytes(data)
        index = self._read_index()
        index[cid] = {
            "cid": cid,
            "size": len(data),
            "stored_at": time.time(),
            "meta": meta or {},
        }
        self._write_index(index)
        return cid

    def put_json(self, obj: Dict[str, Any], meta: Optional[Dict[str, Any]] = None) -> str:
        raw = json.dumps(obj, sort_keys=True, indent=2).encode("utf-8")
        return self.put_bytes(raw, meta=meta)

    def get_bytes(self, cid: str) -> bytes:
        path = self.root / cid
        if not path.exists():
            raise FileNotFoundError(cid)
        return path.read_bytes()

    def get_json(self, cid: str) -> Dict[str, Any]:
        return json.loads(self.get_bytes(cid).decode("utf-8"))

    def exists(self, cid: str) -> bool:
        return (self.root / cid).exists()

    def verify(self, cid: str) -> bool:
        if not self.exists(cid):
            return False
        return self.content_id(self.get_bytes(cid)) == cid
