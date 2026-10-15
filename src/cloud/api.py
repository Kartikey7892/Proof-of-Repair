"""FastAPI service: used-vehicle Proof of Repair + web UI."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from src.blockchain.anchoring import AnchoringService, load_calendar
from src.blockchain.evm_ledger import load_ledger
from src.cloud.registry import VinRegistry, norm_vin
from src.cloud.storage import EvidenceStore
from src.por.proof import EventType, ModelProvenance, ProofOfRepair, build_proof
from src.por.verify import verify_full

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"

app = FastAPI(
    title="Vehicle Proof of Repair API",
    description="Blockchain-anchored repair proofs for second-hand vehicle buyers.",
    version="1.4.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = EvidenceStore(ROOT / "artifacts" / "evidence")
ledger = load_ledger()
calendar = load_calendar(ROOT / "artifacts" / "ots_calendar")
anchoring = AnchoringService(calendar=calendar, ledger=ledger)
registry = VinRegistry(ROOT / "artifacts" / "por_registry.sqlite3")
# One-time import of legacy jsonl VIN files if the DB is empty.
if registry.stats()["proofs"] == 0:
    registry.migrate_jsonl(ROOT / "artifacts" / "vin_registry")

engines: Dict[str, Any] = {}
pending_leaves: List[str] = []
last_batch: Dict[str, Any] = {}

DEMO_CASES = [
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


def _engine_paths() -> Dict[str, Path]:
    return {
        "tinyllama": (
            ROOT / "artifacts/adapters/vehicle-lora-dtc"
            if (ROOT / "artifacts/adapters/vehicle-lora-dtc/adapter_config.json").exists()
            else ROOT / "artifacts/adapters/vehicle-lora"
        ),
        "mistral": ROOT / "artifacts/adapters/mistral-mlx-lora",
    }


def get_engine(name: str = "tinyllama"):
    name = (name or "tinyllama").lower().strip()
    if name == "auto":
        paths = _engine_paths()
        name = "mistral" if (paths["mistral"] / "adapters.safetensors").exists() else "tinyllama"
    if name in engines:
        return engines[name], name

    paths = _engine_paths()
    if name == "mistral":
        from src.llm.mistral_mlx_infer import MistralMLXEngine

        if not (paths["mistral"] / "adapters.safetensors").exists():
            raise HTTPException(400, "Mistral MLX adapter not found")
        eng = MistralMLXEngine(adapter_path=paths["mistral"])
    else:
        from src.llm.infer import DiagnosticEngine

        adapter = paths["tinyllama"]
        if not (adapter / "adapter_config.json").exists():
            raise HTTPException(400, f"TinyLlama adapter missing at {adapter}")
        eng = DiagnosticEngine(adapter_dir=adapter)
        name = "tinyllama"

    engines[name] = eng
    return eng, name


class DiagnoseRequest(BaseModel):
    vin: str = Field(..., min_length=11, max_length=32)
    vehicle: str
    odometer_km: int = Field(..., ge=0)
    symptoms: str
    dtc_codes: str = ""
    sensor_notes: str = ""
    issuer_id: str = "certified-workshop"
    engine: str = "tinyllama"


class AnchorBatchRequest(BaseModel):
    batch_id: str = "ui-batch-001"
    leaf_digests: Optional[List[str]] = None


class VerifyRequest(BaseModel):
    proof: Dict[str, Any]
    merkle_proof: Optional[Dict[str, Any]] = None


@app.get("/api/health")
def health() -> Dict[str, Any]:
    paths = _engine_paths()
    chain: Dict[str, Any] = {"mode": "in_memory_simulator"}
    if hasattr(ledger, "status"):
        try:
            chain = ledger.status()
        except Exception as e:
            chain = {"mode": "error", "detail": str(e)}
    elif ledger.__class__.__name__ == "InMemoryLedger":
        chain = {
            "mode": "in_memory_simulator",
            "note": "Run bash scripts/start_live_chain.sh for a real local EVM",
        }
    ots: Dict[str, Any] = {"mode": "unknown"}
    if hasattr(calendar, "status"):
        try:
            ots = calendar.status()
        except Exception as e:
            ots = {"mode": "error", "detail": str(e)}
    return {
        "status": "ok",
        "domain": "second_hand_vehicle_por",
        "engines": {
            "tinyllama": (paths["tinyllama"] / "adapter_config.json").exists(),
            "mistral": (paths["mistral"] / "adapters.safetensors").exists(),
        },
        "chain": chain,
        "ots": ots,
        "storage": registry.stats(),
        "pending_leaves": len(pending_leaves),
        "proofs": registry.stats()["proofs"],
    }


@app.get("/api/demo_cases")
def demo_cases() -> List[Dict[str, Any]]:
    return DEMO_CASES


@app.post("/api/diagnose_and_prove")
def diagnose_and_prove(req: DiagnoseRequest) -> Dict[str, Any]:
    eng, engine_name = get_engine(req.engine)
    report = eng.diagnose(
        vehicle=req.vehicle,
        symptoms=req.symptoms,
        dtc_codes=req.dtc_codes,
        sensor_notes=req.sensor_notes,
    )
    evidence_cid = store.put_json(
        {
            "vin": req.vin,
            "vehicle": req.vehicle,
            "odometer_km": req.odometer_km,
            "symptoms": req.symptoms,
            "dtc_codes": req.dtc_codes,
            "sensor_notes": req.sensor_notes,
            "report": report.to_dict(),
        },
        meta={"type": "vehicle_repair_evidence"},
    )
    model = ModelProvenance(
        model_name=eng.model_name,
        model_version=eng.model_version,
        adapter_hash=getattr(eng, "adapter_hash", "") or "",
        dataset_merkle_root=getattr(eng, "dataset_merkle_root", "") or "",
    )
    por = build_proof(
        vin=req.vin,
        vehicle=req.vehicle,
        odometer_km=req.odometer_km,
        report=report,
        evidence_cid=evidence_cid,
        model=model,
        issuer_id=req.issuer_id,
        event_type=EventType.REPAIR,
        extra={"audience": "second_hand_buyer", "engine": engine_name},
    )
    pending_leaves.append(por.leaf_digest)
    record = por.to_dict()
    registry.upsert_proof(record)
    return {
        "engine": engine_name,
        "report": report.to_dict(),
        "proof": record,
        "pending_batch_size": len(pending_leaves),
    }


@app.post("/api/anchor_batch")
def anchor_batch(req: AnchorBatchRequest) -> Dict[str, Any]:
    leaves = req.leaf_digests if req.leaf_digests is not None else list(pending_leaves)
    if not leaves:
        raise HTTPException(400, "no leaves to anchor — diagnose at least one VIN first")
    result = anchoring.anchor_batch(leaves, batch_id=req.batch_id)
    # Index proofs by leaf hash for easy verify
    by_leaf = {}
    for p in (result.get("proofs") or {}).values():
        by_leaf[p["leaf_hash_hex"]] = p
    result["proofs_by_leaf"] = by_leaf
    result["leaf_order"] = list(leaves)
    global last_batch
    last_batch = result

    ots = result.get("ots_receipt") or {}
    chain = result.get("chain_tx") or {}
    registry.save_anchor(
        batch_id=str(result.get("batch_id") or req.batch_id),
        merkle_root=str(result.get("merkle_root")),
        leaf_digests=list(leaves),
        ots_receipt=ots if isinstance(ots, dict) else {},
        chain_tx=chain if isinstance(chain, dict) else {"tx_hash": chain},
    )

    if req.leaf_digests is None:
        pending_leaves.clear()
    return result


@app.post("/api/verify")
def verify_endpoint(body: VerifyRequest) -> Dict[str, Any]:
    fields = ProofOfRepair.__dataclass_fields__
    por = ProofOfRepair(**{k: v for k, v in body.proof.items() if k in fields})
    mp = body.merkle_proof
    if mp is None and last_batch.get("proofs_by_leaf"):
        mp = last_batch["proofs_by_leaf"].get(por.leaf_digest)
    return verify_full(por, store=store, merkle_proof=mp, ledger=ledger)


@app.get("/api/proofs")
def list_proofs() -> List[Dict[str, Any]]:
    return registry.list_proofs()


@app.get("/api/vin/{vin}")
def vin_lookup(vin: str) -> Dict[str, Any]:
    """Buyer / dealer / insurer: VIN-bound repair attestation timeline."""
    if len(norm_vin(vin)) < 11:
        raise HTTPException(400, "VIN too short")
    return registry.vin_timeline(vin)


@app.get("/api/proofs/{proof_id}")
def get_proof(proof_id: str) -> Dict[str, Any]:
    por = registry.get_proof(proof_id)
    if not por:
        raise HTTPException(404, "proof not found")
    return por


@app.get("/api/last_batch")
def get_last_batch() -> Dict[str, Any]:
    return last_batch or {}


# --- Static UI ---
if FRONTEND.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND / "assets"), name="assets")


@app.get("/")
def index():
    index_path = FRONTEND / "index.html"
    if not index_path.exists():
        raise HTTPException(404, "frontend missing")
    return FileResponse(index_path)


# Back-compat aliases used by older docs
@app.get("/health")
def health_alias():
    return health()


@app.post("/diagnose_and_prove")
def diagnose_alias(req: DiagnoseRequest):
    return diagnose_and_prove(req)
