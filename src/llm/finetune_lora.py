"""LoRA fine-tune on real vehicle diagnostic datasets (MPS/CUDA/CPU)."""

from __future__ import annotations

import argparse
import json
import time
import uuid
from pathlib import Path

from src.utils.hashing import read_jsonl, sha256_file

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "artifacts"


def finetune(
    model_name: str,
    train_file: Path,
    val_file: Path,
    output_dir: Path,
    epochs: float = 2.0,
    max_steps: int = -1,
    lora_r: int = 16,
    lora_alpha: int = 32,
    lora_dropout: float = 0.05,
    lr: float = 2e-4,
    seed: int = 42,
    max_seq_length: int = 384,
    batch_size: int = 1,
    grad_accum: int = 8,
) -> dict:
    import torch
    from datasets import Dataset
    from peft import LoraConfig, TaskType, get_peft_model
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        DataCollatorForLanguageModeling,
        Trainer,
        TrainingArguments,
    )

    if torch.backends.mps.is_available():
        device_note = "mps"
    elif torch.cuda.is_available():
        device_note = "cuda"
    else:
        device_note = "cpu"
    print(f"[finetune] device={device_note} model={model_name}")

    train_rows = read_jsonl(train_file)
    val_rows = read_jsonl(val_file) if val_file.exists() else []
    print(f"[finetune] train={len(train_rows)} val={len(val_rows)}")

    tokenizer = AutoTokenizer.from_pretrained(model_name, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    dtype = torch.float16 if device_note in {"cuda", "mps"} else torch.float32
    model = AutoModelForCausalLM.from_pretrained(model_name, torch_dtype=dtype)
    lora_config = LoraConfig(
        r=lora_r,
        lora_alpha=lora_alpha,
        lora_dropout=lora_dropout,
        bias="none",
        task_type=TaskType.CAUSAL_LM,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    def tokenize(batch):
        return tokenizer(
            batch["text"],
            truncation=True,
            max_length=max_seq_length,
            padding="max_length",
        )

    train_ds = Dataset.from_list(train_rows).map(
        tokenize, batched=True, remove_columns=list(train_rows[0].keys())
    )
    eval_ds = None
    if val_rows:
        eval_ds = Dataset.from_list(val_rows).map(
            tokenize, batched=True, remove_columns=list(val_rows[0].keys())
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    # ~3% warmup in steps (transformers dropped warmup_ratio in newer versions)
    planned_steps = max_steps if max_steps > 0 else max(1, int(len(train_rows) / max(1, batch_size * grad_accum) * epochs))
    warmup_steps = max(1, int(0.03 * planned_steps))
    # logging_steps=1 so live dashboard updates every optimization step (not every 10)
    # eval disabled mid-train on MPS — eval freezes the visible step counter for minutes
    ta_kwargs = dict(
        output_dir=str(output_dir),
        num_train_epochs=epochs,
        max_steps=max_steps if max_steps > 0 else -1,
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=batch_size,
        gradient_accumulation_steps=grad_accum,
        learning_rate=lr,
        warmup_steps=warmup_steps,
        logging_steps=1,
        save_strategy="steps",
        save_steps=40,
        save_total_limit=2,
        eval_strategy="no",
        fp16=False,  # safer on MPS
        bf16=False,
        seed=seed,
        report_to=[],
        dataloader_pin_memory=False,
        dataloader_num_workers=0,
        remove_unused_columns=False,
    )
    try:
        args = TrainingArguments(**ta_kwargs)
    except TypeError:
        ta_kwargs.pop("eval_strategy", None)
        ta_kwargs["evaluation_strategy"] = "no"
        args = TrainingArguments(**ta_kwargs)

    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)
    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=collator,
    )
    result = trainer.train()
    trainer.save_model(str(output_dir))
    tokenizer.save_pretrained(str(output_dir))

    dataset_root = ""
    manifest = ARTIFACTS / "dataset_manifest.json"
    if manifest.exists():
        dataset_root = json.loads(manifest.read_text())["dataset_merkle_root"]
    adapter_cfg = output_dir / "adapter_config.json"
    adapter_hash = sha256_file(adapter_cfg) if adapter_cfg.exists() else ""

    provenance = {
        "run_id": str(uuid.uuid4()),
        "timestamp": time.time(),
        "domain": "second_hand_vehicle_proof_of_repair",
        "base_model": model_name,
        "method": "LoRA/PEFT",
        "device": device_note,
        "paper_refs": [
            "P7 Hu et al. LoRA",
            "P1 Blockchain-Enabled LLMs for PHM",
            "P4 RSP provenance anchoring",
        ],
        "datasets": [
            "MechanicDB OBD-II",
            "automotive-dtc-finetune",
            "NHTSA complaints",
            "NASA CMAPSS",
            "UCI AI4I 2020",
        ],
        "lora": {
            "r": lora_r,
            "alpha": lora_alpha,
            "dropout": lora_dropout,
            "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"],
        },
        "hyperparameters": {
            "epochs": epochs,
            "max_steps": max_steps,
            "lr": lr,
            "max_seq_length": max_seq_length,
            "batch_size": batch_size,
            "grad_accum": grad_accum,
            "seed": seed,
        },
        "train_samples": len(train_rows),
        "val_samples": len(val_rows),
        "dataset_merkle_root": dataset_root,
        "output_dir": str(output_dir),
        "adapter_hash": adapter_hash,
        "train_loss": float(getattr(result, "training_loss", 0.0) or 0.0),
        "torch_version": torch.__version__,
    }
    run_dir = ARTIFACTS / "finetune_runs"
    run_dir.mkdir(parents=True, exist_ok=True)
    path = run_dir / f"{provenance['run_id']}.json"
    path.write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print(json.dumps(provenance, indent=2))
    print(f"[finetune] saved adapter → {output_dir}")
    print(f"[finetune] provenance → {path}")
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description="Fine-tune vehicle repair LoRA on real datasets")
    parser.add_argument("--model", default="TinyLlama/TinyLlama-1.1B-Chat-v1.0")
    parser.add_argument("--train-file", type=Path, default=ROOT / "data/processed/train.jsonl")
    parser.add_argument("--val-file", type=Path, default=ROOT / "data/processed/val.jsonl")
    parser.add_argument(
        "--output-dir", type=Path, default=ROOT / "artifacts/adapters/vehicle-lora"
    )
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--max-steps", type=int, default=-1)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--grad-accum", type=int, default=8)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    if not args.train_file.exists():
        raise SystemExit("Missing train file. Run: python -m src.llm.prepare_dataset")
    finetune(
        model_name=args.model,
        train_file=args.train_file,
        val_file=args.val_file,
        output_dir=args.output_dir,
        epochs=args.epochs,
        max_steps=args.max_steps,
        lora_r=args.lora_r,
        lora_alpha=args.lora_alpha,
        seed=args.seed,
        batch_size=args.batch_size,
        grad_accum=args.grad_accum,
    )


if __name__ == "__main__":
    main()
