# Resume / paper track

## Cite

**Mistral 98.3% / TinyLlama 93.0%** fault-code on real OBD hold-out (n=57, fair).  
See `artifacts/paper_results.json` and `docs/PAPER_DRAFT.md`.

## Ready

- Paper draft + BibTeX + figures under `docs/`
- Adapters: `mistral-mlx-lora`, `vehicle-lora-dtc`
- Demo: `python scripts/run_demo.py --engine auto`

## Live EVM (local Hardhat)

- Hardhat node + `ProofOfRepair.sol` → `artifacts/chain_config.json`
- API uses `Web3Ledger` when config RPC is up; UI shows **LIVE** chain pill
- Start: `bash scripts/start_live_chain.sh` then `bash scripts/run_ui.sh` → http://127.0.0.1:8000
- Public testnet: copy `.env.example` → `.env` with Sepolia RPC + key, then `bash scripts/deploy_sepolia.sh`

## Live OpenTimestamps

- Default `OTS_MODE=auto/live` submits Merkle roots to public calendars (alice/bob/finney)
- Receipts are `pending` until Bitcoin inclusion; `.ots` files under `artifacts/ots_calendar/`
- Offline demos: `OTS_MODE=sim`
- UI shows **OTS live · pending→BTC**

## VIN attestation registry (product shape)

- Workshop seals repairs to a VIN → batch anchors OTS + EVM
- Buyer/dealer/insurer: paste VIN → timeline (`GET /api/vin/{vin}`)
- Registry files: `artifacts/vin_registry/{VIN}.jsonl`
- UI: **Buyer lookup** first, then workshop bay

## Storage

- **PostgreSQL** app DB via the Node server (`DATABASE_URL`), or embedded PGlite in `artifacts/pglite/` when unset
- **Evidence CAS files**: `artifacts/evidence/` (sha256 content ids)
- **Chain / OTS**: Merkle roots only (integrity), not full reports
- Analytics tables loaded from `data/raw/` by `npm run etl` (see README)

## Optional next

Retrain after NHTSA label fix · LaTeX export · Sepolia credentials · OTS upgrade job · workshop identity
