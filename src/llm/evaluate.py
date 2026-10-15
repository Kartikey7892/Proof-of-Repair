"""Evaluate diagnosis quality with paper-ready, per-source metrics.

Fair protocol (default):
  - Do NOT pass gold fault_code as dtc_codes (avoids hint leakage).
  - Report overall + per-source tables.
  - Optional --sources filter for automotive-only (DTC) eval.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from src.llm.infer import REQUIRED_KEYS
from src.utils.hashing import read_jsonl

ROOT = Path(__file__).resolve().parents[2]

DTC_SOURCES = {"mechanicdb_obd2", "automotive_dtc_finetune", "nhtsa_complaints"}
TRANSFER_SOURCES = {"nasa_cmapss", "uci_ai4i_2020"}


def rouge_l(pred: str, ref: str) -> float:
    a, b = pred.split(), ref.split()
    if not a or not b:
        return 0.0
    dp = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            dp[i][j] = (
                dp[i - 1][j - 1] + 1
                if a[i - 1] == b[j - 1]
                else max(dp[i - 1][j], dp[i][j - 1])
            )
    lcs = dp[-1][-1]
    prec, rec = lcs / len(a), lcs / len(b)
    return 0.0 if prec + rec == 0 else 2 * prec * rec / (prec + rec)


def _empty_bucket() -> Dict[str, Any]:
    return {
        "n": 0,
        "correct": 0,
        "json_ok": 0,
        "schema_ok": 0,
        "severity_ok": 0,
        "rouge": [],
        "errors": 0,
    }


def _summarize(b: Dict[str, Any]) -> Dict[str, Any]:
    n = max(b["n"], 1)
    rouge = b["rouge"]
    return {
        "n": b["n"],
        "fault_code_accuracy": round(b["correct"] / n, 4),
        "json_validity_rate": round(b["json_ok"] / n, 4),
        "schema_completeness_rate": round(b["schema_ok"] / n, 4),
        "severity_accuracy": round(b["severity_ok"] / n, 4),
        "rouge_l_repair_steps": round((sum(rouge) / len(rouge)) if rouge else 0.0, 4),
        "errors": b["errors"],
    }


def _load_engine(engine_name: str, adapter: Optional[Path]):
    if engine_name == "mistral":
        from src.llm.mistral_mlx_infer import MistralMLXEngine

        return MistralMLXEngine(adapter_path=adapter) if adapter else MistralMLXEngine()
    from src.llm.infer import DiagnosticEngine

    return DiagnosticEngine(adapter_dir=adapter) if adapter else DiagnosticEngine()


def evaluate(
    test_file: Path,
    limit: int = 0,
    adapter: Path | None = None,
    sources: Optional[List[str]] = None,
    pass_gold_dtc: bool = False,
    engine_name: str = "tinyllama",
    out_path: Path | None = None,
) -> Dict[str, Any]:
    rows = read_jsonl(test_file)
    if sources:
        allow = set(sources)
        rows = [r for r in rows if r.get("source") in allow]
    if limit and limit > 0:
        rows = rows[:limit]

    engine = _load_engine(engine_name, adapter)
    overall = _empty_bucket()
    by_source: Dict[str, Dict[str, Any]] = defaultdict(_empty_bucket)
    examples: List[Dict[str, Any]] = []

    for i, row in enumerate(rows):
        gold = row["output"] if isinstance(row.get("output"), dict) else {}
        src = str(row.get("source") or "unknown")
        overall["n"] += 1
        by_source[src]["n"] += 1

        dtc_codes = ""
        if pass_gold_dtc and gold.get("fault_code"):
            dtc_codes = str(gold["fault_code"])

        print(f"[eval] {i + 1}/{len(rows)} src={src} id={row.get('id')}", flush=True)
        try:
            pred = engine.diagnose(
                vehicle=row.get("vehicle", "used vehicle"),
                symptoms=str(row.get("input", ""))[:800],
                dtc_codes=dtc_codes,
                sensor_notes="",
                max_new_tokens=512,
            )
            overall["json_ok"] += 1
            by_source[src]["json_ok"] += 1
            pred_d = pred.to_dict()
            if all(k in pred_d for k in REQUIRED_KEYS):
                overall["schema_ok"] += 1
                by_source[src]["schema_ok"] += 1
            if pred.fault_code == gold.get("fault_code"):
                overall["correct"] += 1
                by_source[src]["correct"] += 1
            if pred.severity == gold.get("severity"):
                overall["severity_ok"] += 1
                by_source[src]["severity_ok"] += 1
            rscore = rouge_l(
                " ".join(pred.repair_steps), " ".join(gold.get("repair_steps", []))
            )
            overall["rouge"].append(rscore)
            by_source[src]["rouge"].append(rscore)
            if len(examples) < 8:
                examples.append(
                    {
                        "id": row.get("id"),
                        "source": src,
                        "gold": gold.get("fault_code"),
                        "pred": pred.fault_code,
                        "match": pred.fault_code == gold.get("fault_code"),
                    }
                )
        except Exception as e:
            overall["errors"] += 1
            by_source[src]["errors"] += 1
            print(f"[eval] error on {row.get('id')}: {e}", flush=True)

    # Automotive vs transfer rollups
    auto = _empty_bucket()
    transfer = _empty_bucket()
    for src, b in by_source.items():
        target = auto if src in DTC_SOURCES else transfer if src in TRANSFER_SOURCES else None
        if target is None:
            continue
        for k in ("n", "correct", "json_ok", "schema_ok", "severity_ok", "errors"):
            target[k] += b[k]
        target["rouge"].extend(b["rouge"])

    result = {
        "protocol": {
            "test_file": str(test_file),
            "limit": limit or len(rows),
            "sources_filter": sources,
            "pass_gold_dtc_hint": pass_gold_dtc,
            "engine": engine_name,
        },
        "overall": _summarize(overall),
        "automotive_dtc": _summarize(auto),
        "transfer_domains": _summarize(transfer),
        "by_source": {k: _summarize(v) for k, v in sorted(by_source.items())},
        "model_name": engine.model_name,
        "model_version": engine.model_version,
        "adapter_hash": getattr(engine, "adapter_hash", ""),
        "examples": examples,
    }
    out = out_path or (ROOT / "artifacts" / "eval_metrics.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-file", type=Path, default=ROOT / "data/processed/test_raw.jsonl")
    parser.add_argument("--limit", type=int, default=0, help="0 = all matching rows")
    parser.add_argument("--adapter", type=Path, default=None)
    parser.add_argument(
        "--sources",
        type=str,
        default="",
        help="Comma list, e.g. mechanicdb_obd2,automotive_dtc_finetune,nhtsa_complaints",
    )
    parser.add_argument(
        "--profile",
        choices=("all", "dtc", "transfer"),
        default="all",
        help="Preset source filters for paper tables",
    )
    parser.add_argument(
        "--pass-gold-dtc",
        action="store_true",
        help="Leak gold fault_code into dtc_codes (ablation only; off by default)",
    )
    parser.add_argument("--engine", choices=("tinyllama", "mistral"), default="tinyllama")
    parser.add_argument("--out", type=Path, default=ROOT / "artifacts" / "eval_metrics.json")
    args = parser.parse_args()

    sources: Optional[List[str]] = None
    if args.profile == "dtc":
        sources = sorted(DTC_SOURCES)
    elif args.profile == "transfer":
        sources = sorted(TRANSFER_SOURCES)
    elif args.sources.strip():
        sources = [s.strip() for s in args.sources.split(",") if s.strip()]

    evaluate(
        args.test_file,
        limit=args.limit,
        adapter=args.adapter,
        sources=sources,
        pass_gold_dtc=args.pass_gold_dtc,
        engine_name=args.engine,
        out_path=args.out,
    )


if __name__ == "__main__":
    main()
