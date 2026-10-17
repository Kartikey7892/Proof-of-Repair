#!/bin/bash
# Mistral-7B-Instruct 4bit MLX LoRA only (local weights, offline)
set -e
cd "$(dirname "$0")/.."
source .venv/bin/activate
export PYTHONUNBUFFERED=1
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1

MODEL="$HOME/.cache/huggingface/hub/models--mlx-community--Mistral-7B-Instruct-v0.2-4bit/snapshots/64481e3a4a7bb0990c45c991958f8d6c00c1e785"
if [ ! -f "$MODEL/model.safetensors" ]; then
  echo "Missing local model at $MODEL"
  exit 1
fi

mkdir -p artifacts/adapters/mistral-mlx-lora
echo "=== MLX Mistral LoRA $(date) model=$MODEL ==="

python -m mlx_lm lora \
  --model "$MODEL" \
  --train \
  --data data/mlx \
  --fine-tune-type lora \
  --batch-size 1 \
  --iters 400 \
  --learning-rate 1e-5 \
  --num-layers 8 \
  --max-seq-length 384 \
  --grad-checkpoint \
  --steps-per-report 10 \
  --steps-per-eval 100 \
  --val-batches 5 \
  --save-every 50 \
  --clear-cache-threshold 2000000000 \
  --adapter-path artifacts/adapters/mistral-mlx-lora \
  2>&1 | tee -a artifacts/finetune_mistral_mlx.log

echo "=== MISTRAL LORA DONE $(date) ==="
ls -la artifacts/adapters/mistral-mlx-lora/
read -r _
