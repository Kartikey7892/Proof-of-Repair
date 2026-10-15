# Cloud-Based Proof of Repair for Second-Hand Vehicles
### Blockchain Anchoring + Fine-Tuned Large Language Models

Verifiable repair history for **used-car buyers**: OBD/DTC diagnosis → workshop evidence (CID) → Merkle Proof of Repair → blockchain / OpenTimestamps anchor.

---

## Who it is for

People buying a second-hand vehicle who need cryptographic proof that:

- a specific VIN had a diagnosed fault (e.g. `P0420`)
- listed parts/steps were documented by a workshop
- the record was not silently edited after sale negotiations

---

## Real datasets (downloaded under `data/raw/`)

| Dataset | Path | Role |
|---------|------|------|
| **MechanicDB OBD-II repair sample** | `data/raw/MechanicDB/` | Real DTC → ranked repair procedures, labor, parts |
| **automotive-dtc-finetune** (HF `RRK1987`) | `data/raw/DTC_FT/` | Instruction–response auto diagnostics SFT pairs |
| **NHTSA ODI complaints** | `data/raw/NHTSA/` | Real owner complaints for popular used models |
| **NASA CMAPSS FD001–FD004** | `data/raw/CMAPSS/` | Engine degradation / RUL → powertrain health language |
| **UCI AI4I 2020** | `data/raw/AI4I/ai4i2020.csv` | Labeled failure modes (wear, thermal, power, overstrain) |

Dataset Merkle root + counts: `artifacts/dataset_manifest.json`

---

## Papers / specs used

| ID | Reference | Use |
|----|-----------|-----|
| P1 | Li et al., Blockchain-Enabled LLMs for PHM (2025) | LLM + ledger for health/repair integrity |
| P2 | BladeChain, Scientific Reports (2026) | Off-chain evidence CID + on-chain hash + model provenance |
| P3 | DeviceStamp whitepaper | Lifecycle stamps adapted to VIN repair events |
| P4 | IETF RSP draft | Merkle roll-up + training/inference provenance |
| P6 | NASA CMAPSS (Saxena & Goebel) | Engine RUL / degradation benchmark |
| P7 | LoRA (Hu et al., ICLR 2022) | Parameter-efficient fine-tuning |
| P8 | OpenTimestamps | Calendar timestamp receipts |

---

## Fine-tuning (real LoRA runs)

| Item | TinyLlama (paper DTC) | Mistral 4-bit (MLX) |
|------|----------------------|---------------------|
| Hold-out real OBD (n=57, fair) | Fault **93.0%** · JSON **100%** | Fault **98.3%** · JSON **98.3%** |
| Adapter | `artifacts/adapters/vehicle-lora-dtc/` | `artifacts/adapters/mistral-mlx-lora/` |
| Paper | `docs/PAPER_DRAFT.md` · `docs/figures/` · `artifacts/paper_results.json` |

Live path: `python scripts/run_demo.py --engine auto` (prefers Mistral). No heuristic engine.

---

## Web UI

```bash
source .venv/bin/activate
bash scripts/run_ui.sh
# open http://127.0.0.1:8000
```

Flow: pick a demo VIN → **Diagnose & seal proof** → **Anchor pending batch** → **Verify last proof**.
Prefer **TinyLlama** in the UI for speed; Mistral is more accurate but slower.
# 2) Fine-tune LoRA (uses Apple MPS if available)
python -m src.llm.finetune_lora --epochs 2

# 3) Live VIN cases → proofs → Merkle → verify (auto = Mistral if trained)
python scripts/run_demo.py --engine auto

# 4) Hold-out metrics (TinyLlama adapter)
python -m src.llm.evaluate --limit 40 --adapter artifacts/adapters/vehicle-lora

# 5) Crypto unit tests
python -m pytest tests/ -q

# 6) API (optional)
uvicorn src.cloud.api:app --reload
```

---

## Proof object (buyer-facing)

Each leaf commits: `VIN + vehicle + odometer + report_hash + evidence_cid + model provenance`.

Raw invoices/photos stay off-chain (CID). Only Merkle roots go on-chain (`contracts/ProofOfRepair.sol`).
