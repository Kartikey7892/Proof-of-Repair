#!/bin/bash
# Fair DTC hold-out eval for Mistral MLX adapter (paper Table 2)
set -e
cd "/Users/shivansh/Desktop/proof of repair"
source .venv/bin/activate
export PYTHONUNBUFFERED=1
export HF_HUB_OFFLINE=1

echo "=== Mistral fair DTC eval $(date) ==="
python -u -m src.llm.evaluate \
  --engine mistral \
  --profile dtc \
  --out artifacts/eval_metrics_mistral_dtc.json \
  2>&1 | tee artifacts/eval_mistral_dtc.log

echo "=== MISTRAL EVAL DONE $(date) ==="
read -r _
