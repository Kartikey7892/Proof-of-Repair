"""Optional MLX Mistral adapter inference (Apple Silicon)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Optional

from src.llm.infer import (
    SYSTEM_PROMPT,
    is_runaway_text,
    normalize_report,
    parse_repair_json,
)
from src.por.proof import RepairReport

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ADAPTER = ROOT / "artifacts" / "adapters" / "mistral-mlx-lora"
DEFAULT_MODEL = str(
    Path.home()
    / ".cache/huggingface/hub/models--mlx-community--Mistral-7B-Instruct-v0.2-4bit"
    / "snapshots/64481e3a4a7bb0990c45c991958f8d6c00c1e785"
)
HF_MODEL_ID = "mlx-community/Mistral-7B-Instruct-v0.2-4bit"


class MistralMLXEngine:
    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        adapter_path: Optional[Path] = None,
    ):
        from mlx_lm import load, generate
        from mlx_lm.sample_utils import make_logits_processors, make_sampler

        self._generate = generate
        self._make_logits_processors = make_logits_processors
        self._make_sampler = make_sampler
        adapter_path = Path(adapter_path) if adapter_path else DEFAULT_ADAPTER
        if not adapter_path.exists():
            raise FileNotFoundError(f"MLX adapter missing: {adapter_path}")
        self.model, self.tokenizer = load(model, adapter_path=str(adapter_path))
        self.model_name = f"mlx-lora:{HF_MODEL_ID}"
        self.model_version = "mistral-mlx-v1"
        weights = adapter_path / "adapters.safetensors"
        if weights.exists():
            self.adapter_hash = hashlib.sha256(weights.read_bytes()).hexdigest()
        else:
            self.adapter_hash = ""
        self.dataset_merkle_root = ""
        manifest = ROOT / "artifacts" / "dataset_manifest.json"
        if manifest.exists():
            self.dataset_merkle_root = json.loads(manifest.read_text()).get(
                "dataset_merkle_root", ""
            )

    def _complete(self, prompt: str, max_new_tokens: int) -> str:
        processors = self._make_logits_processors(
            repetition_penalty=1.18,
            repetition_context_size=64,
        )
        # Light temperature breaks greedy token loops without wrecking JSON structure.
        sampler = self._make_sampler(temp=0.2, top_p=0.9)
        return self._generate(
            self.model,
            self.tokenizer,
            prompt=prompt,
            max_tokens=max_new_tokens,
            verbose=False,
            sampler=sampler,
            logits_processors=processors,
        )

    def diagnose(
        self,
        vehicle: str,
        symptoms: str,
        dtc_codes: str = "",
        sensor_notes: str = "",
        max_new_tokens: int = 480,
    ) -> RepairReport:
        dtc = dtc_codes.split(",")[0].strip() if dtc_codes else ""
        user = (
            f"Vehicle: {vehicle}\nDTCs: {dtc_codes or 'none'}\n"
            f"Symptoms: {symptoms}\nNotes: {sensor_notes}\n"
            "Return ONE compact JSON object. diagnosis <= 2 sentences. "
            "Include non-empty parts and repair_steps arrays (3-5 items). "
            "Do not repeat words or acronyms."
        )
        seed_fc = json.dumps(dtc or "UNKNOWN")
        seed_prefix = f'{{"fault_code": {seed_fc}, "diagnosis": "'
        prompt = (
            f"### System\n{SYSTEM_PROMPT}\n\n"
            f"### User\nDiagnose this used vehicle for a Proof of Repair record.\n\n{user}\n\n"
            f"### Assistant\n{seed_prefix}"
        )
        text = self._complete(prompt, max_new_tokens=max_new_tokens)
        gen = text if text.strip().startswith("{") else seed_prefix + text
        parsed = parse_repair_json(gen)
        if not parsed or is_runaway_text(str(parsed.get("diagnosis", ""))):
            seed_prefix2 = f'{{"fault_code":{seed_fc},"severity":"medium","diagnosis":"'
            retry = (
                f"### System\n{SYSTEM_PROMPT}\n\n"
                f"### User\nDiagnose this used vehicle for a Proof of Repair record.\n\n{user}\n\n"
                f"### Assistant\n{seed_prefix2}"
            )
            text = self._complete(retry, max_new_tokens=max_new_tokens)
            gen = text if text.strip().startswith("{") else seed_prefix2 + text
            parsed = parse_repair_json(gen) or parsed
        if not parsed:
            raise RuntimeError(f"MLX model bad JSON:\n{gen[:700]}")
        if dtc and not str(parsed.get("fault_code", "")).strip():
            parsed["fault_code"] = dtc
        return RepairReport.from_dict(
            normalize_report(parsed, fallback_dtc=dtc, symptoms=symptoms)
        )
