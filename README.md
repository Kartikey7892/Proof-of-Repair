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

Live path: `python scripts/run_demo.py --engine auto` (prefers Mistral).

---

## Backend: Node.js + Express + PostgreSQL

The web API lives in [`server/`](server/) (TypeScript, Express 4). It replaces the
former FastAPI service with the **same `/api/*` routes and response shapes**, and adds
PostgreSQL storage, a data-analysis layer and a knowledge-base diagnosis engine.

```bash
cd server
npm install
npm start            # http://127.0.0.1:8000  ·  API docs at /docs
```

### PostgreSQL

| Mode | How | When |
|------|-----|------|
| **Real PostgreSQL** | set `DATABASE_URL` (see `.env.example`); `docker compose up -d` starts a matching Postgres 16 | development / production |
| **Embedded PostgreSQL** (PGlite) | leave `DATABASE_URL` unset — data in `artifacts/pglite/` | zero-setup demo, tests |

Both run the identical SQL schema ([`server/src/db/schema.ts`](server/src/db/schema.ts)):
`proofs`, `anchors`, `proof_anchors` (per-proof Merkle inclusion proofs, so any anchored
proof verifies after a restart), `evidence`, `vin_lookups`, plus the analytics tables.
Migrations run on startup (`npm run db:migrate` to run them alone).

### Data analysis

On first start the ETL (`npm run etl`, `-- --force` to reload) loads the real datasets into PostgreSQL,
fingerprinting each source in `etl_runs` for lineage:

| Table(s) | Source | Rows |
|----------|--------|------|
| `nhtsa_complaints`, `nhtsa_complaint_components` | `data/raw/NHTSA/*.json` | 4,221 complaints |
| `dtc_codes`, `dtc_fixes`, `dtc_parts` | `data/raw/MechanicDB/*.parquet` | 90 codes · 320 ranked fixes · 449 parts |
| `dtc_ft_examples` | `data/raw/DTC_FT/*.parquet` | 140 labelled examples |
| `ai4i_readings` | `data/raw/AI4I/ai4i2020.csv` | 10,000 readings |
| `model_benchmarks` | `artifacts/paper_results.json` | 6 results |

Analytics endpoints (all aggregation in SQL — CTEs, window functions, `percentile_cont`, `generate_series`):

| Endpoint | What it answers |
|----------|-----------------|
| `GET /api/analytics/overview?days=30` | sealed/anchored KPIs, median seal→anchor time, daily trend, severity / engine / make mix, top fault codes, buyer-lookup hit rate |
| `GET /api/analytics/complaints?make=&model=&year=` | NHTSA complaints by component, vehicle, incident year; component-share heatmap |
| `GET /api/analytics/vehicle-risk?vehicle=2016 Honda Civic` | buyer risk profile: complaint share per component and **lift vs. fleet average** |
| `GET /api/analytics/dtc` · `/dtc/:code` | repair-knowledge stats; per-code fixes, parts, cost, severity labels, registry occurrences |
| `GET /api/analytics/ai4i` | failure-mode rates by quality type, tool wear, torque |
| `GET /api/analytics/models` · `/datasets` | model benchmarks · dataset lineage |

The web UI's **04 · Insights** section charts these, and the buyer VIN lookup shows the
vehicle's known-issue profile under its repair timeline.

### Diagnosis engines

| Engine | Runs where | Notes |
|--------|-----------|-------|
| `kb` | Node (built-in) | Retrieval over MechanicDB (DTC → ranked fixes, parts, cost, labor) with severity priors from automotive-dtc-finetune. Instant; its provenance hash pins the exact knowledge snapshot. |
| `tinyllama`, `mistral` | Python sidecar | `python ml/inference_server.py` (port 8001) serves the LoRA adapters from `artifacts/adapters/`; Express calls it over HTTP. |
| `auto` (default) | — | mistral → tinyllama → kb, whichever is available. |

### Anchoring

- **EVM**: ethers v6 against `artifacts/chain_config.json` (local Hardhat via `scripts/start_live_chain.sh`, or Sepolia); otherwise a file-persisted simulator.
- **OpenTimestamps**: roots are submitted to the public calendars and stored as standard `.ots` files; a background job (and `POST /api/ots/upgrade`) upgrades pending receipts once Bitcoin confirms them. `OTS_MODE=sim` for offline demos.

### Tests

```bash
cd server
npm test        # 40 tests: Python byte-parity, crypto, registry, API, analytics, pg wire protocol
npm run typecheck
```

Proof hashes are byte-compatible with the original Python implementation (canonical JSON
reproduces `json.dumps(sort_keys=True)` exactly — `1.0` floats, `\uXXXX` escapes, exponent
format). `server/test/fixtures/gen_parity.py` regenerates the reference vectors from `src/`.
Set `TEST_DATABASE_URL` to run the wire-protocol test against your own PostgreSQL.

---

## Web UI

```bash
bash scripts/run_ui.sh        # or: cd server && npm start
# open http://127.0.0.1:8000
```

Flow: look up a VIN → pick a demo vehicle → **Seal repair to VIN** → **Anchor pending batch** → **Verify last proof** → **Insights**.

---

## ML track (Python)

```bash
# 1) Fine-tune LoRA (uses Apple MPS if available)
python -m src.llm.finetune_lora --epochs 2

# 2) Live VIN cases → proofs → Merkle → verify (auto = Mistral if trained)
python scripts/run_demo.py --engine auto

# 3) Hold-out metrics (TinyLlama adapter)
python -m src.llm.evaluate --limit 40 --adapter artifacts/adapters/vehicle-lora

# 4) Crypto reference tests
python -m pytest tests/ -q

# 5) Serve trained adapters to the Node API
python ml/inference_server.py
```

---

## Proof object (buyer-facing)

Each leaf commits: `VIN + vehicle + odometer + report_hash + evidence_cid + model provenance`.

Raw invoices/photos stay off-chain (CID). Only Merkle roots go on-chain (`contracts/ProofOfRepair.sol`).
