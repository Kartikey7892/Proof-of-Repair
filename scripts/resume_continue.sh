#!/bin/bash
# Resume from CONTINUE.md: eval + demo, then Mistral LoRA (weights may still be downloading)
set -e
cd "/Users/shivansh/Desktop/proof of repair"
source .venv/bin/activate
export PYTHONUNBUFFERED=1

echo "=== eval TinyLlama $(date) ==="
python -u -m src.llm.evaluate --limit 40 --adapter artifacts/adapters/vehicle-lora \
  2>&1 | tee artifacts/eval_v2.log

echo "=== demo $(date) ==="
python -u scripts/run_demo.py 2>&1 | tee artifacts/demo_v2.log

echo "=== wait for Mistral weights if needed $(date) ==="
BLOB="$HOME/.cache/huggingface/hub/models--mlx-community--Mistral-7B-Instruct-v0.2-4bit/blobs"
HASH="b6099fc60dbc05ebc6ac0a357f94f28ea2d9a998f132bd0d9d19abcd2a047fba"
EXPECTED=4262357066
while true; do
  if [ -f "$BLOB/$HASH" ]; then
    SZ=$(stat -f%z "$BLOB/$HASH")
    if [ "$SZ" -ge "$EXPECTED" ]; then
      echo "weights ready ($SZ bytes)"
      break
    fi
  fi
  if [ -f "$BLOB/${HASH}.partial" ]; then
    SZ=$(stat -f%z "$BLOB/${HASH}.partial")
    PCT=$(python3 -c "print(f'{100*$SZ/$EXPECTED:.1f}')")
    echo "waiting for download… ${PCT}% ($SZ / $EXPECTED)"
  else
    echo "waiting for download… (no partial yet)"
  fi
  # if curl not running and partial incomplete, fail soft
  if ! pgrep -f "curl.*${HASH}" >/dev/null 2>&1 && [ ! -f "$BLOB/$HASH" ]; then
    echo "WARN: curl not running and weights missing — attempting one resume"
    (
      cd "$BLOB"
      curl -L --retry 12 --retry-delay 3 -C - -o "${HASH}.partial" \
        "https://huggingface.co/mlx-community/Mistral-7B-Instruct-v0.2-4bit/resolve/main/model.safetensors" \
        && mv "${HASH}.partial" "$HASH"
    ) || { echo "MISTRAL_DOWNLOAD_FAILED"; exit 0; }
  fi
  sleep 20
done

echo "=== MLX Mistral LoRA $(date) ==="
python -m mlx_lm lora \
  --model mlx-community/Mistral-7B-Instruct-v0.2-4bit \
  --train \
  --data data/mlx \
  --fine-tune-type lora \
  --batch-size 1 \
  --iters 400 \
  --learning-rate 1e-5 \
  --num-layers 8 \
  --max-seq-length 512 \
  --grad-checkpoint \
  --steps-per-report 10 \
  --steps-per-eval 100 \
  --adapter-path artifacts/adapters/mistral-mlx-lora \
  2>&1 | tee -a artifacts/finetune_mistral_mlx.log || echo "MISTRAL_MLX_FAILED"

echo "=== ALL DONE $(date) ==="
read -r _
