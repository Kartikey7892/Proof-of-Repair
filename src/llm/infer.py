"""Real LoRA-backed vehicle diagnostic engine with robust JSON extraction."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

from src.por.proof import RepairReport

ROOT = Path(__file__).resolve().parents[2]
_DTC = ROOT / "artifacts" / "adapters" / "vehicle-lora-dtc"
_LEGACY = ROOT / "artifacts" / "adapters" / "vehicle-lora"
DEFAULT_ADAPTER = _DTC if (_DTC / "adapter_config.json").exists() else _LEGACY

SYSTEM_PROMPT = (
    "You are an expert automotive diagnostics assistant for used-vehicle Proof of Repair. "
    "Reply with ONE complete valid JSON object only. No markdown. No prose before/after. "
    "Required keys: fault_code (string), diagnosis (string), severity (low|medium|high), "
    "parts (array of strings), repair_steps (array of strings), qa_checks (array of strings), "
    "estimated_minutes (integer), confidence (number 0-1), buyer_advice (string). "
    "Keep diagnosis under 400 characters. Close all brackets."
)

REQUIRED_KEYS = [
    "fault_code",
    "diagnosis",
    "severity",
    "parts",
    "repair_steps",
    "qa_checks",
    "estimated_minutes",
    "confidence",
    "buyer_advice",
]


def _balance_json(text: str) -> Optional[str]:
    """Extract first {...} span and close truncated braces/brackets if needed."""
    start = text.find("{")
    if start < 0:
        return None
    blob = text[start:]
    # Strip markdown fences
    blob = blob.replace("```json", "").replace("```", "")
    depth = 0
    in_str = False
    esc = False
    end = None
    for i, ch in enumerate(blob):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end is not None:
        return blob[:end]
    # Truncated: close open string / braces / brackets roughly
    if in_str:
        blob += '"'
    # count brackets
    opens = blob.count("[") - blob.count("]")
    braces = blob.count("{") - blob.count("}")
    # remove trailing comma
    blob = re.sub(r",\s*$", "", blob)
    blob += "]" * max(0, opens)
    blob += "}" * max(0, braces)
    return blob


def parse_repair_json(text: str) -> Optional[Dict[str, Any]]:
    candidates: List[str] = []
    balanced = _balance_json(text)
    if balanced:
        candidates.append(balanced)
    # also try whole text
    candidates.append(text.strip())
    for cand in candidates:
        for attempt in (cand, re.sub(r",\s*}", "}", re.sub(r",\s*]", "]", cand))):
            try:
                obj = json.loads(attempt)
                if isinstance(obj, dict):
                    return obj
            except json.JSONDecodeError:
                # progressive trim
                for i in range(len(attempt), max(0, len(attempt) - 800), -1):
                    try:
                        obj = json.loads(attempt[:i])
                        if isinstance(obj, dict):
                            return obj
                    except json.JSONDecodeError:
                        continue
    return None


def collapse_runaway_text(text: str, max_len: int = 400) -> str:
    """Collapse ECM/ECM/… and other token-loop degeneration from small LLMs."""
    s = str(text or "").strip()
    if not s:
        return s
    # slash- or pipe-separated repeats
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"(\b[\w.+#-]{1,32}\b)(?:\s*[|/]\s*\1){2,}", r"\1", s, flags=re.I)
        s = re.sub(r"(\b[\w.+#-]{2,32}\b)(?:\s+\1){3,}", r"\1", s, flags=re.I)
    s = re.sub(r"\s{2,}", " ", s).strip(" /|-")
    if len(s) > max_len:
        s = s[: max_len - 1].rstrip() + "…"
    return s


def is_runaway_text(text: str) -> bool:
    s = str(text or "")
    if len(s) > 500 and len(set(s.split())) < 12:
        return True
    return bool(re.search(r"(\b[\w.+#-]{1,32}\b)(?:\s*[|/]\s*\1){4,}", s, flags=re.I))


def workshop_defaults(fault_code: str, symptoms: str = "") -> Dict[str, Any]:
    """Deterministic fill-ins when the model omits steps/parts or degenerates."""
    fc = (fault_code or "UNKNOWN").upper().strip()
    sym = (symptoms or "").lower()
    if fc.startswith("P042") or "catalytic" in sym or "emissions" in sym:
        return {
            "diagnosis": f"{fc}: catalyst efficiency below threshold — exhaust leak, O2 sensor, or converter.",
            "parts": ["Downstream O2 sensor", "Catalytic converter (if confirmed)"],
            "repair_steps": [
                "Confirm P0420 with freeze-frame and bidirectional O2 data",
                "Smoke/inspect exhaust for pre-cat leaks",
                "Compare upstream vs downstream O2 switching",
                "Replace failed sensor or converter; clear codes; verify monitors",
            ],
            "qa_checks": ["No P0420 after drive cycle", "Catalyst monitor ready/pass"],
            "estimated_minutes": 120,
        }
    if fc.startswith("P030") or "misfire" in sym:
        return {
            "diagnosis": f"{fc}: cylinder misfire — ignition, injector, compression, or vacuum leak.",
            "parts": ["Spark plugs", "Ignition coil(s)"],
            "repair_steps": [
                "Pull misfire counts and freeze-frame",
                "Swap coil/plug to confirm cylinder follow",
                "Check fuel trims and injector contribution",
                "Repair root cause; clear codes; road-test under load",
            ],
            "qa_checks": ["Misfire counts remain zero", "No CEL after mixed drive"],
            "estimated_minutes": 90,
        }
    if fc.startswith("C") or "abs" in sym or "wheel speed" in sym:
        return {
            "diagnosis": f"{fc}: ABS wheel-speed circuit fault — sensor, tone ring, or wiring.",
            "parts": ["Wheel speed sensor", "Sensor pigtail / connector"],
            "repair_steps": [
                "Scan ABS module and note which corner failed",
                "Inspect harness for chafe at knuckle/strut",
                "Measure sensor resistance and signal while spinning hub",
                "Replace sensor if out of range; clear ABS codes; road-test",
            ],
            "qa_checks": ["ABS light off", "All wheel-speed PIDs agree in a straight line"],
            "estimated_minutes": 75,
        }
    return {
        "diagnosis": f"{fc}: workshop inspection required for used-vehicle attestation.",
        "parts": ["Diagnostic time / scan tool"],
        "repair_steps": [
            "Confirm DTC with OEM-level scan",
            "Inspect related connectors and grounds",
            "Repair verified fault; clear codes; document post-repair screenshot",
        ],
        "qa_checks": ["DTC does not return", "Buyer receives invoice + OBD screenshot"],
        "estimated_minutes": 60,
    }


def normalize_report(
    data: Dict[str, Any],
    fallback_dtc: str = "",
    symptoms: str = "",
) -> Dict[str, Any]:
    out = dict(data)
    out.setdefault("fault_code", fallback_dtc or "UNKNOWN")
    out.setdefault("diagnosis", "See workshop inspection notes.")
    sev = str(out.get("severity", "medium")).lower()
    if sev not in {"low", "medium", "high", "critical"}:
        sev = "medium"
    if sev == "critical":
        sev = "high"
    out["severity"] = sev
    for key in ("parts", "repair_steps", "qa_checks"):
        val = out.get(key, [])
        if isinstance(val, str):
            val = [val]
        if not isinstance(val, list):
            val = []
        cleaned = []
        for x in val:
            sx = collapse_runaway_text(str(x), max_len=220)
            if sx and not is_runaway_text(sx):
                cleaned.append(sx)
        out[key] = cleaned[:12]
    try:
        out["estimated_minutes"] = int(float(out.get("estimated_minutes", 60)))
    except (TypeError, ValueError):
        out["estimated_minutes"] = 60
    try:
        out["confidence"] = float(out.get("confidence", 0.7))
    except (TypeError, ValueError):
        out["confidence"] = 0.7
    out["confidence"] = max(0.0, min(1.0, out["confidence"]))
    out.setdefault(
        "buyer_advice",
        "Request repair invoice and post-repair OBD screenshot before purchase.",
    )
    out["diagnosis"] = collapse_runaway_text(
        re.sub(r"\*+", "", str(out["diagnosis"])), max_len=400
    )
    out["buyer_advice"] = collapse_runaway_text(str(out["buyer_advice"]), max_len=400)
    out["fault_code"] = str(out["fault_code"])[:64]

    defaults = workshop_defaults(str(out["fault_code"]), symptoms=symptoms)
    if is_runaway_text(out["diagnosis"]) or len(out["diagnosis"]) < 12:
        out["diagnosis"] = defaults["diagnosis"]
        out["confidence"] = min(out["confidence"], 0.55)
    if not out["repair_steps"]:
        out["repair_steps"] = list(defaults["repair_steps"])
    if not out["parts"]:
        out["parts"] = list(defaults["parts"])
    if not out["qa_checks"]:
        out["qa_checks"] = list(defaults["qa_checks"])
    return out


class DiagnosticEngine:
    """Loads a fine-tuned LoRA adapter. Raises if adapter is missing."""

    def __init__(self, adapter_dir: Optional[Path] = None, device: Optional[str] = None):
        self.adapter_dir = Path(adapter_dir) if adapter_dir else DEFAULT_ADAPTER
        if not (self.adapter_dir / "adapter_config.json").exists():
            raise FileNotFoundError(
                f"Trained adapter not found at {self.adapter_dir}. "
                "Run: python -m src.llm.finetune_lora"
            )

        if device:
            self.device = device
        elif torch.backends.mps.is_available():
            self.device = "mps"
        elif torch.cuda.is_available():
            self.device = "cuda"
        else:
            self.device = "cpu"

        cfg = json.loads((self.adapter_dir / "adapter_config.json").read_text())
        base = cfg.get("base_model_name_or_path", "TinyLlama/TinyLlama-1.1B-Chat-v1.0")
        self.tokenizer = AutoTokenizer.from_pretrained(str(self.adapter_dir), use_fast=True)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        dtype = torch.float16 if self.device in {"cuda", "mps"} else torch.float32
        base_model = AutoModelForCausalLM.from_pretrained(base, dtype=dtype)
        self.model = PeftModel.from_pretrained(base_model, str(self.adapter_dir))
        self.model.to(self.device)
        self.model.eval()
        # Avoid transformers warning when both max_length and max_new_tokens are set
        if getattr(self.model, "generation_config", None) is not None:
            self.model.generation_config.max_length = None

        self.model_name = f"peft:{base}"
        self.model_version = "vehicle-lora-v2"
        self.adapter_hash = hashlib.sha256(
            (self.adapter_dir / "adapter_config.json").read_bytes()
        ).hexdigest()
        manifest = ROOT / "artifacts" / "dataset_manifest.json"
        self.dataset_merkle_root = ""
        if manifest.exists():
            self.dataset_merkle_root = json.loads(manifest.read_text()).get(
                "dataset_merkle_root", ""
            )

    def diagnose(
        self,
        vehicle: str,
        symptoms: str,
        dtc_codes: str = "",
        sensor_notes: str = "",
        max_new_tokens: int = 512,
    ) -> RepairReport:
        user = (
            f"Vehicle: {vehicle}\n"
            f"DTCs: {dtc_codes or 'none reported'}\n"
            f"Symptoms: {symptoms}\n"
            f"Notes: {sensor_notes}\n"
            "Return complete JSON now."
        )
        prompt = (
            f"### System\n{SYSTEM_PROMPT}\n\n"
            f"### User\nDiagnose this used vehicle for a Proof of Repair record.\n\n{user}\n\n"
            f"### Assistant\n{{"
        )
        # Seed with `{` to bias toward JSON object completion
        inputs = self.tokenizer(prompt, return_tensors="pt")
        inputs = {k: v.to(self.device) for k, v in inputs.items()}
        with torch.no_grad():
            out = self.model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                pad_token_id=self.tokenizer.eos_token_id,
                eos_token_id=self.tokenizer.eos_token_id,
            )
        full = self.tokenizer.decode(out[0], skip_special_tokens=True)
        gen = full.split("### Assistant\n")[-1]
        if not gen.strip().startswith("{"):
            gen = "{" + gen
        parsed = parse_repair_json(gen)
        if not parsed:
            # one retry with stricter reminder
            retry_prompt = prompt + '"fault_code":'
            inputs = self.tokenizer(retry_prompt, return_tensors="pt")
            inputs = {k: v.to(self.device) for k, v in inputs.items()}
            with torch.no_grad():
                out = self.model.generate(
                    **inputs,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                    pad_token_id=self.tokenizer.eos_token_id,
                )
            full = self.tokenizer.decode(out[0], skip_special_tokens=True)
            gen = full.split("### Assistant\n")[-1]
            if not gen.strip().startswith("{"):
                gen = "{" + gen
            parsed = parse_repair_json(gen)
        if not parsed:
            raise RuntimeError(f"Model did not return valid JSON. Output was:\n{gen[:700]}")
        normalized = normalize_report(
            parsed,
            fallback_dtc=(dtc_codes.split(",")[0].strip() if dtc_codes else ""),
            symptoms=symptoms,
        )
        return RepairReport.from_dict(normalized)
