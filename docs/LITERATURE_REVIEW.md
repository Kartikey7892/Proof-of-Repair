# Literature — Vehicle Proof of Repair

Mapped to **second-hand vehicle** repair attestation (VIN-bound).

| ID | Work | Vehicle PoR mapping |
|----|------|---------------------|
| P1 | Li et al. Blockchain-Enabled LLMs for PHM (2025) | LLM diagnosis + blockchain integrity for health/repair |
| P2 | BladeChain (Sci Rep 2026) | Off-chain repair evidence CID; on-chain hash; model provenance fields |
| P3 | DeviceStamp whitepaper | Lifecycle stamps → VIN repair / PPI / OBD-clear events |
| P4 | IETF RSP draft | Merkle roll-up of PoR leaves + fine-tune provenance receipts |
| P5 | PdM provenance (Computers 2024) | Log hyperparameters, dataset root, adapter hash |
| P6 | NASA CMAPSS | Powertrain degradation analogue for used-vehicle PPI |
| P7 | LoRA (ICLR 2022) | Fine-tune TinyLlama on OBD/NHTSA/CMAPSS mixes |
| P8 | OpenTimestamps | Timestamp Merkle roots for buyer-verifiable history |

## Product thesis

Used-car markets suffer from asymmetric information (hidden accident/repair history). A cloud PoR system lets workshops publish tamper-evident repair records that buyers can verify without trusting a single dealer PDF.
