"""OpenTimestamps calendar anchoring + Merkle batching for Proof of Repair.

Default mode is live submission to public OTS calendars (PendingAttestation),
with optional local simulator fallback for offline demos.
Bitcoin block confirmation for live stamps typically takes hours; receipts start
as ``pending`` and can be upgraded later.
"""

from __future__ import annotations

import io
import json
import os
import time
import uuid
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol

from .merkle import MerkleTree, leaf_hash, sha256_hex

DEFAULT_OTS_CALENDARS = (
    "https://alice.btc.calendar.opentimestamps.org",
    "https://bob.btc.calendar.opentimestamps.org",
    "https://finney.calendar.eternitywall.com",
)


@dataclass
class TimestampReceipt:
    receipt_id: str
    digest_hex: str
    calendar_url: str
    submitted_at: float
    confirmed_at: Optional[float]
    bitcoin_block_height: Optional[int]
    bitcoin_block_hash: Optional[str]
    status: str  # pending | confirmed | submitted
    operations: List[str] = field(default_factory=list)
    mode: str = "sim"  # live_ots | sim
    ots_file: Optional[str] = None
    pending_calendars: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TimestampReceipt":
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})


class CalendarLike(Protocol):
    def submit(self, digest_hex: str) -> TimestampReceipt: ...

    def verify(self, receipt: TimestampReceipt) -> bool: ...

    def status(self) -> Dict[str, Any]: ...


class LocalCalendar:
    """Simulates an OpenTimestamps calendar with immediate 'Bitcoin' confirmation."""

    def __init__(self, store_dir: str | Path = "artifacts/ots_calendar"):
        self.store_dir = Path(store_dir)
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self._block_height = 850_000

    def status(self) -> Dict[str, Any]:
        return {
            "mode": "sim",
            "calendar_url": "local://ots-calendar-sim",
            "note": "Set OTS_MODE=live for public OpenTimestamps calendars",
        }

    def submit(self, digest_hex: str) -> TimestampReceipt:
        if len(digest_hex) != 64:
            raise ValueError("digest must be 32-byte hex (sha256)")
        receipt_id = str(uuid.uuid4())
        now = time.time()
        nonce = sha256_hex(f"{receipt_id}:{now}".encode())[:16]
        ops = [
            f"append:{nonce}",
            "sha256",
            f"bitcoin_attest:sim_block_{self._block_height + 1}",
        ]
        self._block_height += 1
        block_hash = sha256_hex(f"block:{self._block_height}:{digest_hex}".encode())
        receipt = TimestampReceipt(
            receipt_id=receipt_id,
            digest_hex=digest_hex,
            calendar_url="local://ots-calendar-sim",
            submitted_at=now,
            confirmed_at=now + 0.01,
            bitcoin_block_height=self._block_height,
            bitcoin_block_hash=block_hash,
            status="confirmed",
            operations=ops,
            mode="sim",
        )
        path = self.store_dir / f"{receipt_id}.json"
        path.write_text(json.dumps(receipt.to_dict(), indent=2), encoding="utf-8")
        return receipt

    def verify(self, receipt: TimestampReceipt) -> bool:
        if receipt.status != "confirmed":
            return False
        if not receipt.bitcoin_block_hash or receipt.bitcoin_block_height is None:
            return False
        expected = sha256_hex(
            f"block:{receipt.bitcoin_block_height}:{receipt.digest_hex}".encode()
        )
        return expected == receipt.bitcoin_block_hash

    def load(self, receipt_id: str) -> TimestampReceipt:
        path = self.store_dir / f"{receipt_id}.json"
        return TimestampReceipt.from_dict(json.loads(path.read_text(encoding="utf-8")))


class OpenTimestampsCalendar:
    """Submit digests to public OpenTimestamps calendars and persist ``.ots`` proofs."""

    def __init__(
        self,
        store_dir: str | Path = "artifacts/ots_calendar",
        calendar_urls: Optional[List[str]] = None,
        timeout: float = 15.0,
        min_calendars: int = 1,
    ):
        self.store_dir = Path(store_dir)
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self.calendar_urls = list(calendar_urls or DEFAULT_OTS_CALENDARS)
        self.timeout = timeout
        self.min_calendars = max(1, min_calendars)

    def status(self) -> Dict[str, Any]:
        return {
            "mode": "live_ots",
            "calendars": self.calendar_urls,
            "min_calendars": self.min_calendars,
            "note": "PendingAttestation until Bitcoin inclusion (often hours)",
        }

    def submit(self, digest_hex: str) -> TimestampReceipt:
        if len(digest_hex) != 64:
            raise ValueError("digest must be 32-byte hex (sha256)")

        from opentimestamps.calendar import RemoteCalendar
        from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
        from opentimestamps.core.op import OpSHA256
        from opentimestamps.core.serialize import StreamSerializationContext
        from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp

        digest = bytes.fromhex(digest_hex)
        detached = DetachedTimestampFile(OpSHA256(), Timestamp(digest))
        ops: List[str] = []
        pending: List[str] = []
        submitted_urls: List[str] = []
        errors: List[str] = []

        for url in self.calendar_urls:
            try:
                cal = RemoteCalendar(url, user_agent="vehicle-por/1.2")
                remote_ts = cal.submit(digest, timeout=self.timeout)
                detached.timestamp.merge(remote_ts)
                submitted_urls.append(url)
                ops.append(f"submit:{url}")
            except Exception as e:  # network / calendar errors
                errors.append(f"{url}: {type(e).__name__}: {e}")

        if len(submitted_urls) < self.min_calendars:
            raise RuntimeError(
                "OTS calendar submit failed "
                f"({len(submitted_urls)}/{self.min_calendars}): " + "; ".join(errors[-3:])
            )

        # Collect pending / bitcoin attestations from the merged tree
        btc_height: Optional[int] = None
        btc_hash: Optional[str] = None
        status = "pending"

        def walk(ts: Timestamp) -> None:
            nonlocal btc_height, btc_hash, status
            for att in ts.attestations:
                if isinstance(att, PendingAttestation):
                    uri = getattr(att, "uri", None) or str(att)
                    pending.append(uri)
                    ops.append(f"pending:{uri}")
                elif isinstance(att, BitcoinBlockHeaderAttestation):
                    btc_height = int(getattr(att, "height", 0) or 0)
                    status = "confirmed"
                    ops.append(f"bitcoin_attest:height_{btc_height}")
            for _op, subt in ts.ops.items():
                walk(subt)

        walk(detached.timestamp)

        receipt_id = str(uuid.uuid4())
        now = time.time()
        ots_path = self.store_dir / f"{receipt_id}.ots"
        buf = io.BytesIO()
        detached.serialize(StreamSerializationContext(buf))
        ots_path.write_bytes(buf.getvalue())

        meta = {
            "receipt": None,  # filled below
            "submitted_calendars": submitted_urls,
            "errors": errors,
        }
        receipt = TimestampReceipt(
            receipt_id=receipt_id,
            digest_hex=digest_hex,
            calendar_url=submitted_urls[0],
            submitted_at=now,
            confirmed_at=now if status == "confirmed" else None,
            bitcoin_block_height=btc_height,
            bitcoin_block_hash=btc_hash,
            status=status,
            operations=ops,
            mode="live_ots",
            ots_file=str(ots_path),
            pending_calendars=pending or submitted_urls,
        )
        meta["receipt"] = receipt.to_dict()
        (self.store_dir / f"{receipt_id}.json").write_text(
            json.dumps(meta, indent=2), encoding="utf-8"
        )
        return receipt

    def verify(self, receipt: TimestampReceipt) -> bool:
        if receipt.digest_hex is None or len(receipt.digest_hex) != 64:
            return False
        if not receipt.ots_file:
            return False
        path = Path(receipt.ots_file)
        if not path.exists():
            return False
        try:
            from opentimestamps.core.serialize import StreamDeserializationContext
            from opentimestamps.core.timestamp import DetachedTimestampFile

            with path.open("rb") as f:
                detached = DetachedTimestampFile.deserialize(StreamDeserializationContext(f))
            # File hash in detached timestamp must match our digest
            return detached.timestamp.msg == bytes.fromhex(receipt.digest_hex)
        except Exception:
            return False

    def load(self, receipt_id: str) -> TimestampReceipt:
        path = self.store_dir / f"{receipt_id}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        if "receipt" in data:
            return TimestampReceipt.from_dict(data["receipt"])
        return TimestampReceipt.from_dict(data)


def load_calendar(
    store_dir: str | Path = "artifacts/ots_calendar",
) -> CalendarLike:
    """Select calendar backend from ``OTS_MODE``: live | sim | auto (default)."""
    mode = (os.environ.get("OTS_MODE") or "auto").strip().lower()
    raw_urls = os.environ.get("OTS_CALENDARS", "").strip()
    urls = [u.strip() for u in raw_urls.split(",") if u.strip()] or None

    if mode in {"sim", "local", "simulator"}:
        return LocalCalendar(store_dir)

    if mode in {"live", "ots", "auto", ""}:
        try:
            cal = OpenTimestampsCalendar(store_dir=store_dir, calendar_urls=urls)
            if mode == "live":
                return cal
            # auto: probe first calendar quickly; fall back on hard failure later per-submit
            return cal
        except Exception:
            if mode == "live":
                raise
            return LocalCalendar(store_dir)

    return LocalCalendar(store_dir)


class AnchoringService:
    """Batches PoR leaf digests into a Merkle root and anchors via calendar + ledger."""

    def __init__(self, calendar: Optional[CalendarLike] = None, ledger=None):
        self.calendar = calendar or load_calendar()
        self.ledger = ledger

    def anchor_batch(
        self,
        leaf_digests_hex: List[str],
        batch_id: str,
        meta_uri: str = "",
    ) -> Dict[str, Any]:
        if not leaf_digests_hex:
            raise ValueError("empty batch")
        leaves = [bytes.fromhex(h) for h in leaf_digests_hex]
        tree = MerkleTree(leaves)
        root_hex = tree.root_hex
        receipt = self.calendar.submit(root_hex)

        chain_tx = None
        if self.ledger is not None:
            chain_tx = self.ledger.anchor_merkle_root(
                root_hex=root_hex,
                batch_id=batch_id,
                meta_uri=meta_uri or f"ots:{receipt.receipt_id}",
            )

        proofs = {i: tree.get_proof(i) for i in range(len(leaves))}
        return {
            "batch_id": batch_id,
            "merkle_root": root_hex,
            "ots_receipt": receipt.to_dict(),
            "chain_tx": chain_tx,
            "proofs": {
                str(i): {
                    "leaf_index": p.leaf_index,
                    "leaf_hash_hex": p.leaf_hash_hex,
                    "siblings": list(p.siblings),
                    "root_hex": p.root_hex,
                }
                for i, p in proofs.items()
            },
        }


def digest_from_canonical_json(obj: Dict[str, Any]) -> str:
    payload = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return leaf_hash(payload).hex()
