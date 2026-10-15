# System Architecture

## Components

### A. LLM Diagnosis Layer (`src/llm/`)

- `prepare_dataset.py` — builds SFT JSONL from SARC (+ optional CMAPSS)
- `finetune_lora.py` — PEFT/LoRA training + provenance logging
- `infer.py` — loads adapter (or heuristic fallback) → `RepairReport`
- `evaluate.py` — fault-code / JSON / ROUGE metrics

### B. Proof of Repair Layer (`src/por/`)

A PoR object is a canonical JSON document:

```
device_id || report_hash || evidence_cid || model_provenance || issuer || timestamp
```

SHA-256 of the canonical serialization is the **leaf digest**.

### C. Cloud Evidence Store (`src/cloud/`)

- Writes repair photos / logs / JSON reports to content-addressed paths
- Returns `cid = sha256(bytes)` (IPFS-compatible abstraction)
- FastAPI service (`api.py`) for create / get / verify endpoints

### D. Blockchain Anchoring (`src/blockchain/`)

1. **Merkle tree** over batch of leaf digests  
2. **OpenTimestamps-style** calendar simulator issues a receipt  
3. **EVM contract** `ProofOfRepair.sol` stores Merkle roots by batch id  

### E. Smart Contract (`contracts/ProofOfRepair.sol`)

```
anchorMerkleRoot(bytes32 root, string batchId, string metaURI)
isRootAnchored(bytes32 root) → bool
```

Raw repair data never enters the contract — only roots (BladeChain / DeviceStamp pattern).

## Security Properties (Assignment Scope)

| Property | Mechanism |
|----------|-----------|
| Integrity | SHA-256 leaf + Merkle inclusion |
| Tamper evidence | Any byte change breaks digest / path |
| Timestamp | Calendar / chain anchor time |
| Confidentiality | Off-chain storage; on-chain hashes only |
| Model accountability | `model_name`, `adapter_hash` in leaf |

## Trust Flow

```
Technician notes + sensors
        → LLM RepairReport
        → Cloud CID
        → PoR leaf hash
        → Merkle root
        → Blockchain / OTS receipt
        → Anyone can verify
```
