#!/bin/bash
# Paper main: TinyLlama LoRA on DTC-primary disjoint split
set -e
cd "/Users/shivansh/Desktop/proof of repair"
source .venv/bin/activate
export PYTHONUNBUFFERED=1

echo "=== prepare dtc profile $(date) ==="
python -m src.llm.prepare_dataset --profile dtc --seed 42

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
        if not line.strip(): continue
        o=json.loads(line)
        rows.append({"text": o["text"]})
    Path(dst).write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows)+"\n")
    print(dst, len(rows))
PY

OUT=artifacts/adapters/vehicle-lora-dtc
echo "=== TinyLlama LoRA DTC-primary → $OUT $(date) ==="
python -u -m src.llm.finetune_lora \
  --model TinyLlama/TinyLlama-1.1B-Chat-v1.0 \
  --epochs 3 \
  --max-steps -1 \
  --batch-size 1 \
  --grad-accum 4 \
  --output-dir "$OUT" \
  2>&1 | tee artifacts/finetune_dtc.log

echo "=== fair DTC eval TinyLlama $(date) ==="
python -u -m src.llm.evaluate \
  --engine tinyllama \
  --adapter "$OUT" \
  --profile dtc \
  --out artifacts/eval_metrics_tinyllama_dtc.json \
  2>&1 | tee artifacts/eval_tinyllama_dtc.log

echo "=== TINY DTC DONE $(date) ==="
read -r _
