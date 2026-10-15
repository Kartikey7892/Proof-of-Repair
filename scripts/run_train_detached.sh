#!/bin/bash
# Detached train — writes PID file; survives Cursor terminal aborts.
set -e
cd "/Users/shivansh/Desktop/proof of repair"
source .venv/bin/activate
mkdir -p artifacts/adapters/vehicle-lora

if [ -f artifacts/adapters/vehicle-lora/adapter_config.json ]; then
  echo "Adapter exists — skip train"
  exit 0
fi

echo "=== train start $(date) ===" >> artifacts/finetune_train.log
PYTHONUNBUFFERED=1 python -u -m src.llm.finetune_lora \
  --epochs 1 \
  --max-steps 120 \
  --batch-size 1 \
  --grad-accum 4 \
  --output-dir artifacts/adapters/vehicle-lora \
  >> artifacts/finetune_train.log 2>&1 &
TPID=$!
echo $TPID > artifacts/train.pid
echo "train_pid=$TPID"
wait $TPID
EC=$?
echo "=== train end $(date) exit=$EC ===" >> artifacts/finetune_train.log
rm -f artifacts/train.pid
exit $EC
