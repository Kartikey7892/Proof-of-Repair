# Cloud-Based Proof of Repair — Reviewer Notes

## What to read first

1. [`README.md`](../README.md) — problem, papers, datasets, fine-tuning summary  
2. [`docs/LITERATURE_REVIEW.md`](LITERATURE_REVIEW.md) — paper → code mapping (P1–P8)  
3. [`docs/DATASETS_AND_FINETUNING.md`](DATASETS_AND_FINETUNING.md) — vehicle corpora + LoRA results  
4. [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — system diagram  

## Papers used (short list)

| ID | Work | Role |
|----|------|------|
| P1 | Li et al. Blockchain-Enabled LLMs for PHM (2025) | LLM + blockchain integrity for health management |
| P2 | BladeChain / Scientific Reports (2026) | Off-chain CID + on-chain hash + model provenance |
| P3 | DeviceStamp whitepaper | Lifecycle repair stamps adapted to VIN events |
| P4 | IETF RSP draft | Merkle roll-up + OTS-style AI provenance anchoring |
| P5 | Provenance system for PdM (Computers 2024) | Training hyperparameter / lineage logging |
| P6 | NASA CMAPSS | Sensor→text SFT transfer (powertrain health) |
| P7 | LoRA (Hu et al., ICLR 2022) | Parameter-efficient fine-tuning |
| P8 | OpenTimestamps | Calendar timestamp receipts |

## Datasets tuned (real)

MechanicDB OBD-II, automotive-dtc-finetune, NHTSA complaints, NASA CMAPSS FD001–FD004, UCI AI4I 2020 → ≈ **2327 / 290 / 292** train/val/test (`artifacts/dataset_manifest.json`).

## Fine-tuning results

| Model | Method | Result |
|-------|--------|--------|
| TinyLlama-1.1B-Chat | PEFT LoRA, 2 epochs (~1164 steps) | train_loss ≈ **0.40** · `artifacts/adapters/vehicle-lora/` |
| Mistral-7B-Instruct v0.2 **4-bit** | MLX LoRA, 400 iters | train **0.364** / val **0.384** · `artifacts/adapters/mistral-mlx-lora/` |

TinyLlama hold-out eval (n=40): JSON validity **87.5%**, schema **87.5%**, fault-code accuracy **22.5%** (mixed DTC + CMAPSS labels), ROUGE-L repair steps **0.19** → `artifacts/eval_metrics.json`.

Provenance: `artifacts/finetune_runs/`.

## How to reproduce the review demo

```bash
cd "proof of repair"
source .venv/bin/activate

# Use trained adapters (already under artifacts/adapters/)
python scripts/run_demo.py --engine auto          # prefers Mistral MLX if present
# or: python scripts/run_demo.py --engine tinyllama

python -m src.llm.evaluate --limit 40 --adapter artifacts/adapters/vehicle-lora
python -m pytest tests/ -q
```

Optional retrain: `scripts/train_improved.sh` (TinyLlama) or `scripts/train_mistral_mlx.sh` (Mistral).

## Deliverable artifacts

- `artifacts/vehicle_batch_manifest.json` — Merkle batch + VIN proofs  
- `artifacts/eval_metrics.json` — hold-out metrics  
- `contracts/ProofOfRepair.sol` — on-chain root registry  
