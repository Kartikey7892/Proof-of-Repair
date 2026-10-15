# Research / paper status

## Headline results (cite these)

**Real OBD hold-out** (MechanicDB + DTC-FT, n=57, fair, DTC-disjoint):

| Model | Fault-code | JSON |
|-------|----------:|-----:|
| **Mistral-7B 4-bit MLX LoRA** | **98.3%** | 98.3% |
| TinyLlama LoRA (DTC-primary) | **93.0%** | 100% |

Consolidated: `artifacts/paper_results.json` · Draft: `docs/PAPER_DRAFT.md`

## Deliverables ready for writing

| Artifact | Path |
|----------|------|
| Paper draft | `docs/PAPER_DRAFT.md` |
| BibTeX | `docs/references.bib` |
| Figures | `docs/figures/fig1_architecture.png`, `fig2_merkle.png`, `fig3_obd_results.png` |
| Metrics | `artifacts/eval_metrics_mistral_obd.json`, `…_tinyllama_obd.json` |

## Also done

- NHTSA labels fixed to component codes (no `NHTSA_` prefix); dataset rebuilt — **retrain** later if you want better NHTSA exact-match
- Demo prefers Mistral, else `vehicle-lora-dtc`

## Optional next

1. Short LoRA retrain on fixed-NHTSA data  
2. Expand BibTeX with full author lists / DOIs  
3. Export `PAPER_DRAFT.md` → LaTeX/Word  
4. Anvil/Sepolia root anchor for appendix  
