# Datasets & Fine-Tuning — Second-Hand Vehicle Proof of Repair

## Real datasets used

| Dataset | Location | Samples used | License / source |
|---------|----------|--------------|------------------|
| MechanicDB OBD-II repair sample | `data/raw/MechanicDB/*.parquet` | 320 DTC×fix rows | HF `Ichlibitiche/mechanicdb-obd2-repair-sample` |
| Automotive DTC fine-tune | `data/raw/DTC_FT/*.parquet` | 119 train + 21 val chat pairs | HF `RRK1987/automotive-dtc-finetune` |
| NHTSA ODI complaints | `data/raw/NHTSA/*.json` | up to 80/model across Camry, Civic, F-150, Elantra, Malibu, Altima, 3-Series, Corolla | https://api.nhtsa.gov |
| NASA CMAPSS FD001–FD004 | `data/raw/CMAPSS/` | 300 windows × 4 subsets | NASA PCoE / HF mirror |
| UCI AI4I 2020 | `data/raw/AI4I/ai4i2020.csv` | all failures + 400 healthy | UCI ML Repository |

Prepared mix (seed=42): see `artifacts/dataset_manifest.json`  
≈ **2327 train / 290 val / 292 test** instruction–JSON pairs for used-vehicle PoR.

## Fine-tuning (completed runs)

| Item | Value |
|------|-------|
| **Paper main** TinyLlama DTC-primary | 3 epochs, disjoint-disjoint, train_loss≈0.59 → `artifacts/adapters/vehicle-lora-dtc/` |
| Real OBD hold-out (n=57, fair) | JSON **100%** · fault-code **93.0%** · MechanicDB 90.9% · DTC-FT 95.8% |
| Mistral 4-bit MLX | 400 iters → `artifacts/adapters/mistral-mlx-lora/` (eval running) |
| NHTSA exact-match | Not meaningful (`NHTSA_*` synthetic labels) — report ROUGE / separate |

Scripts: `scripts/train_paper_dtc.sh`, `scripts/train_mistral_mlx.sh`. Demo: `python scripts/run_demo.py --engine auto`. Paper: `docs/PAPER_DRAFT.md`.


## Buyer-facing output schema

```json
{
  "fault_code": "P0420",
  "diagnosis": "...",
  "severity": "medium",
  "parts": ["..."],
  "repair_steps": ["..."],
  "qa_checks": ["..."],
  "estimated_minutes": 120,
  "confidence": 0.86,
  "buyer_advice": "Ask seller for ..."
}
```

Each report is hashed into a VIN-bound Proof of Repair leaf and Merkle-anchored.
