#!/bin/bash
cd "/Users/shivansh/Desktop/proof of repair"
source .venv/bin/activate
export PYTHONUNBUFFERED=1
echo "=============================================="
echo " Vehicle LoRA fine-tune — keep this window open"
echo "=============================================="
echo "=== train start $(date) ===" | tee -a artifacts/finetune_train.log
python -u -m src.llm.finetune_lora \
  --epochs 1 \
  --max-steps 120 \
  --batch-size 1 \
  --grad-accum 4 \
  --output-dir artifacts/adapters/vehicle-lora \
  2>&1 | tee -a artifacts/finetune_train.log
echo "=== train end $(date) ===" | tee -a artifacts/finetune_train.log
if [ -f artifacts/adapters/vehicle-lora/adapter_config.json ]; then
  echo "Adapter ready — running VIN Proof-of-Repair demo..."
  python -u scripts/run_demo.py 2>&1 | tee -a artifacts/demo_run.log
fi
echo "DONE. You can close this window."
read -r _
