#!/bin/bash
# Longer TinyLlama LoRA (2 epochs) + optional MLX Mistral-4bit LoRA
set -e
cd "$(dirname "$0")/.."
source .venv/bin/activate
export PYTHONUNBUFFERED=1

echo "=== rebuild dataset $(date) ==="
python -m src.llm.prepare_dataset

# MLX data layout
mkdir -p data/mlx
python - <<'PY'
import json
from pathlib import Path
for src, dst in [
    ("data/processed/train.jsonl", "data/mlx/train.jsonl"),
    ("data/processed/val.jsonl", "data/mlx/valid.jsonl"),
    ("data/processed/test.jsonl", "data/mlx/test.jsonl"),
]:
    rows=[]
    for line in Path(src).read_text().splitlines():
        if not line.strip():
            continue
        o=json.loads(line)
        rows.append({"text": o["text"]})
    Path(dst).write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows)+"\n")
    print(dst, len(rows))
PY

echo "=== TinyLlama 2-epoch LoRA $(date) ==="
python -u -m src.llm.finetune_lora \
  --model TinyLlama/TinyLlama-1.1B-Chat-v1.0 \
  --epochs 2 \
  --max-steps -1 \
  --batch-size 1 \
  --grad-accum 4 \
  --output-dir artifacts/adapters/vehicle-lora \
  2>&1 | tee -a artifacts/finetune_v2.log

echo "=== Try MLX Mistral-7B-Instruct 4bit LoRA $(date) ==="
# Quantized Mistral for Apple Silicon (~4-6GB)
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
  2>&1 | tee -a artifacts/finetune_mistral_mlx.log || echo "MISTRAL_MLX_FAILED (continuing with TinyLlama)"

echo "=== eval TinyLlama adapter $(date) ==="
python -u -m src.llm.evaluate --limit 40 --adapter artifacts/adapters/vehicle-lora \
  2>&1 | tee artifacts/eval_v2.log

echo "=== demo $(date) ==="
python -u scripts/run_demo.py 2>&1 | tee artifacts/demo_v2.log || true

echo "=== ALL DONE $(date) ==="
read -r _
