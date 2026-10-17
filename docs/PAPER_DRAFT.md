# Cloud-Based Proof of Repair for Second-Hand Vehicles
### Blockchain Anchoring with Fine-Tuned Large Language Models

> Working research draft — numbers below match repository artifacts (2026-08-28).

---

## Abstract

Used-car markets suffer from asymmetric information: buyers cannot reliably verify that claimed repairs occurred on a specific VIN. We present a **Proof of Repair (PoR)** system that (i) fine-tunes compact LLMs with LoRA on real automotive diagnostic corpora to emit structured repair reports, (ii) hashes each report with VIN, odometer, evidence CID, and model provenance into a Merkle leaf, and (iii) anchors batch Merkle roots via OpenTimestamps calendars and an on-chain registry contract. On a **DTC-disjoint** automotive hold-out (MechanicDB + DTC-FT + NHTSA), we evaluate JSON validity, schema completeness, fault-code accuracy, severity accuracy, and ROUGE-L of repair steps for TinyLlama-1.1B and Mistral-7B-Instruct (4-bit MLX) adapters. Cryptographic verification (leaf digest, Merkle inclusion, tamper detection) is demonstrated end-to-end with live local EVM anchoring and public OTS PendingAttestation receipts (Bitcoin confirmation asynchronous).

**Keywords:** Proof of Repair, used vehicles, LoRA, OBD-II, Merkle tree, OpenTimestamps, blockchain provenance

---

## 1. Introduction

Used-vehicle transactions are classic lemon markets: sellers can claim repairs that never happened, attach invoices to the wrong car, or clear DTCs without fixing root causes. Buyers, dealers, auction houses, and insurers need a **VIN-bound attestation timeline**—what was claimed fixed, by whom, at what odometer, with what evidence—not another marketplace.

We therefore build Proof of Repair as a **repair attestation registry**: workshops seal structured repair reports to a vehicle identifier; digests are Merkle-batched and anchored (OpenTimestamps + EVM registry); second-hand buyers (and adjacent parties) look up the VIN and verify integrity. Diagnosis LLMs assist workshops in producing structured claims; cryptography makes those claims checkable.

Second-hand vehicle purchase decisions depend on repair history that is easy to forge in PDF form. Prior work combines LLMs with ledgers for prognostics and health management (PHM) [P1], off-chain evidence with on-chain hashes [P2], device lifecycle stamps [P3], and Merkle roll-up of AI provenance [P4]. We specialize this stack to **VIN-bound automotive PoR** for buyer verification.

**Contributions**

1. A reproducible SFT pipeline over real OBD/DTC and complaint data with **globally DTC-disjoint** train/val/test splits.
2. LoRA adapters (TinyLlama; Mistral-7B 4-bit on Apple MLX) that emit buyer-facing repair JSON suitable for hashing.
3. A PoR leaf schema committing report hash, evidence CID, and **model provenance** (adapter hash, dataset Merkle root).
4. End-to-end verification with tamper detection; honest discussion of simulated vs production anchoring.

---

## 2. Related Work

| ID | Work | Relevance |
|----|------|-----------|
| P1 | Li et al., Blockchain-Enabled LLMs for PHM (2025) | LLM + ledger integrity for health/repair |
| P2 | BladeChain (Sci. Rep. 2026) | Off-chain CID + on-chain hash + model provenance |
| P3 | DeviceStamp whitepaper | Lifecycle event stamps → VIN repair events |
| P4 | IETF RSP draft | Merkle roll-up + training/inference provenance |
| P5 | PdM provenance (Computers 2024) | Hyperparameter / lineage logging |
| P6 | NASA CMAPSS | Optional transfer / powertrain analogue (ablation) |
| P7 | LoRA (Hu et al., ICLR 2022) | Parameter-efficient fine-tuning |
| P8 | OpenTimestamps | Calendar timestamping of Merkle roots |

---

## 3. System Architecture

```
Symptoms / DTC  →  LoRA LLM  →  RepairReport JSON
                                      ↓
                         EvidenceStore (local CID)
                                      ↓
              PoR leaf = H(VIN ‖ vehicle ‖ odo ‖ report ‖ cid ‖ model)
                                      ↓
                         Merkle batch of leaves
                                      ↓
              OTS-style receipt  +  EVM registry (root only)
                                      ↓
                         Buyer verify_full()
```

Implementation: `src/llm/`, `src/por/`, `src/blockchain/`, `chain/contracts/ProofOfRepair.sol`, `scripts/run_demo.py`.

---

## 4. Datasets and Splits

### 4.1 Corpora

| Corpus | Role | n (raw) |
|--------|------|--------:|
| MechanicDB OBD-II repair sample | Real DTC → ranked fixes | 320 |
| RRK1987/automotive-dtc-finetune | Instruction–diagnosis pairs | 140 |
| NHTSA ODI complaints (8 models) | Owner symptom narratives | 510 |
| NASA CMAPSS FD001–FD004 | Transfer ablation only | 1200 |
| UCI AI4I 2020 | Transfer ablation only | 739 |

### 4.2 Paper main split (profile=`dtc`)

- Sources: MechanicDB + DTC-FT + NHTSA only.
- Split: **80/10/10** with **global group keys** `dtc:{code}` / `nhtsa:{code}` so the same fault code never appears in two splits.
- Seed: 42.
- Current sizes: see `artifacts/dataset_manifest.json` (`train` / `val` / `test`, `dataset_merkle_root`).

**Leakage check (OBD DTC codes):** train ∩ test = **0**, train ∩ val = **0**, val ∩ test = **0**.

Earlier mixed-domain runs (~41% CMAPSS) inflated wrong-domain predictions under exact fault-code match; those results are archived as `artifacts/eval_metrics_mixed_v1_leaky.json` / `dataset_manifest_mixed_v1.json` for comparison, not as the main claim.

---

## 5. Fine-Tuning

| Setting | TinyLlama (paper DTC) | Mistral-7B-Instruct 4-bit |
|---------|-----------------------|---------------------------|
| Method | PEFT LoRA r=16, α=32, q/k/v/o | MLX LoRA, 8 layers |
| Hardware | Apple MPS | Apple MLX |
| Objective | Causal LM on `### System/User/Assistant` JSON | Same text format |
| Checkpoint | `artifacts/adapters/vehicle-lora-dtc/` | `artifacts/adapters/mistral-mlx-lora/` |
| Provenance | `artifacts/finetune_runs/*.json` | includes adapter SHA-256 |

Target schema keys: `fault_code`, `diagnosis`, `severity`, `parts`, `repair_steps`, `qa_checks`, `estimated_minutes`, `confidence`, `buyer_advice`.

---

## 6. Evaluation Protocol

Fair protocol (`src/llm.evaluate`):

1. **No gold DTC hint** in `dtc_codes` (symptoms/input only).
2. Metrics: JSON validity, schema completeness, exact `fault_code` accuracy, severity accuracy, ROUGE-L on repair steps.
3. Report **overall** and **by_source** tables.
4. Engines: TinyLlama PEFT and optional Mistral MLX.

### Table 2 — Automotive hold-out (fair protocol: no gold DTC hint)

**Primary claim — real OBD DTCs** (MechanicDB + automotive-dtc-finetune, n=57):

| Model | JSON↑ | Schema↑ | Fault-code↑ | Severity↑ | ROUGE-L↑ |
|-------|------:|--------:|------------:|----------:|---------:|
| TinyLlama-1.1B LoRA (DTC-primary, 3 ep.) | **1.000** | **1.000** | **0.930** | 0.561 | 0.133 |
| Mistral-7B-Instruct 4-bit MLX LoRA | **0.983** | **0.983** | **0.983** | 0.597 | 0.239 |

Per-source (same fair protocol):

| Model | MechanicDB fault↑ (n=33) | DTC-FT fault↑ (n=24) |
|-------|-------------------------:|---------------------:|
| TinyLlama | 0.909 | 0.958 |
| Mistral MLX | 0.970 | **1.000** |

**Full DTC-profile** including NHTSA (n=163; NHTSA used synthetic `NHTSA_*` labels at train time — exact-match depressed):

| Model | JSON↑ | Fault-code↑ | Severity↑ | ROUGE-L↑ |
|-------|------:|------------:|----------:|---------:|
| TinyLlama | 0.828 | 0.325 | 0.601 | 0.327 |
| Mistral MLX | 0.969 | 0.436 | 0.669 | 0.550 |

| Baseline (do not cite as main) | n | Fault-code |
|--------------------------------|--:|-----------:|
| TinyLlama mixed + leaky eval (CMAPSS-heavy) | 40 | 0.225 |

Artifacts: `artifacts/eval_metrics_tinyllama_obd.json`, `artifacts/eval_metrics_mistral_obd.json`, `artifacts/eval_metrics_*_dtc.json`, `artifacts/paper_results.json`.

---

## 7. Blockchain Anchoring and Verification

**Real cryptography (this repo):** SHA-256 leaf digests, Merkle inclusion proofs, report-hash tamper detection.

**Simulated production edges:** evidence “CID” is a local content-addressed file store. OpenTimestamps submits to public calendars by default (`OTS_MODE=live`, receipts start as `pending` until Bitcoin inclusion). EVM anchoring uses a live Hardhat/Sepolia `Web3Ledger` when `artifacts/chain_config.json` points at a running node; otherwise it falls back to an in-memory simulator. `ProofOfRepair.sol` defines the on-chain API (`anchorMerkleRoot`).

Demo batch (Mistral): `artifacts/vehicle_batch_manifest.json` — all three sample VINs verify `all_ok=true`; mutating `fault_code` fails `report_hash` as required.

---

## 8. Threat Model and Limitations

- Workshop collusion can still attest false repairs; PoR proves **integrity and provenance of attested records**, not physical truth.
- Exact fault-code match is strict; synonymous DTCs are counted wrong.
- NHTSA labels use synthetic `NHTSA_*` codes — report separately in by_source tables.
- Simulated OTS immediate Bitcoin confirmation is only used when `OTS_MODE=sim`; live mode waits for real calendar→Bitcoin attestation.

---

## 9. Reproducibility

```bash
source .venv/bin/activate
python -m src.llm.prepare_dataset --profile dtc --seed 42
bash scripts/train_paper_dtc.sh          # TinyLlama DTC LoRA + fair eval
python -m src.llm.evaluate --engine mistral --profile dtc \
  --out artifacts/eval_metrics_mistral_dtc.json
python scripts/run_demo.py --engine auto
python -m pytest tests/ -q
```

Publish with paper: dataset Merkle root, adapter hashes, seed, commit hash.

---

## 10. Conclusion

We operationalize VIN-bound Proof of Repair with LoRA diagnosis and Merkle/ledger anchoring. Under a DTC-disjoint fair protocol, **Mistral-7B 4-bit LoRA reaches 98.3% fault-code accuracy** and TinyLlama **93.0%** on real OBD hold-out (n=57), with near-perfect JSON validity. Future work: improved NHTSA component labeling (now component codes without `NHTSA_` prefix), constrained decoding, larger OBD corpora, and Sepolia/mainnet root anchoring with upgraded OTS Bitcoin attestations.

---

## References (short)

Full BibTeX: [`docs/references.bib`](references.bib). Mapping: [`docs/LITERATURE_REVIEW.md`](LITERATURE_REVIEW.md). Figures: [`docs/figures/`](figures/).
