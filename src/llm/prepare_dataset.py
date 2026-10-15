"""Build real vehicle SFT corpora from MechanicDB, DTC-FT, NHTSA, CMAPSS, AI4I.

Target user: second-hand vehicle buyers who need verifiable Proof of Repair.
"""

from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pandas as pd

from src.utils.hashing import merkle_root_of_strings, write_jsonl

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
ARTIFACTS = ROOT / "artifacts"

SYSTEM_PROMPT = (
    "You are an expert automotive diagnostics assistant for used-vehicle Proof of Repair. "
    "Reply with ONE complete valid JSON object only. No markdown. No prose before/after. "
    "Required keys: fault_code (string), diagnosis (string), severity (low|medium|high), "
    "parts (array of strings), repair_steps (array of strings), qa_checks (array of strings), "
    "estimated_minutes (integer), confidence (number 0-1), buyer_advice (string). "
    "Keep diagnosis under 400 characters. Close all brackets."
)


def _json_output(**kwargs) -> str:
    return json.dumps(kwargs, ensure_ascii=False)


def from_mechanicdb() -> List[Dict[str, Any]]:
    path = RAW / "MechanicDB" / "dtc_fixes_joined.parquet"
    df = pd.read_parquet(path)
    rows: List[Dict[str, Any]] = []
    for _, r in df.iterrows():
        steps = [
            s.strip()
            for s in str(r["step_by_step_instructions"]).replace("•", "|").split("|")
            if s.strip()
        ]
        labor_h = float(r.get("est_labor_hours") or 1.0)
        severity = "high" if str(r["system_category"]).lower() in {"chassis", "safety"} else "medium"
        if "Easy" in str(r.get("difficulty_level", "")):
            sev = "low" if severity != "high" else "medium"
        else:
            sev = severity
        output = {
            "fault_code": str(r["dtc_code"]),
            "diagnosis": str(r["detailed_technical_explanation"])[:900],
            "severity": sev,
            "parts": [str(r["fix_title"])],
            "repair_steps": steps[:8] or [str(r["fix_title"])],
            "qa_checks": [
                "clear_dtc_and_rescan",
                "road_test_no_warning_lights",
                "verify_related_pids_in_spec",
            ],
            "estimated_minutes": int(max(20, round(labor_h * 60))),
            "confidence": round(0.92 - 0.05 * int(r.get("probability_rank") or 1), 2),
            "buyer_advice": (
                f"For a used-car purchase: ask seller for proof that DTC {r['dtc_code']} "
                f"({r['short_description']}) was repaired and codes cleared after a drive cycle."
            ),
        }
        rows.append(
            {
                "id": f"MDB-{r['dtc_code']}-{r['fix_id']}",
                "source": "mechanicdb_obd2",
                "vehicle": str(r.get("oem_make") or "OBD-II vehicle"),
                "instruction": (
                    "Diagnose this OBD-II trouble code for a second-hand vehicle inspection "
                    "and produce a structured repair plan JSON."
                ),
                "input": (
                    f"DTC: {r['dtc_code']} | System: {r['system_category']} | "
                    f"Fault family: {r['fault_family']} | "
                    f"Description: {r['short_description']} | "
                    f"Ranked fix #{r['probability_rank']}: {r['fix_title']}"
                ),
                "output": output,
            }
        )
    return rows


def from_dtc_finetune() -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for split, name in [("train", "train.parquet"), ("validation", "validation.parquet")]:
        path = RAW / "DTC_FT" / name
        if not path.exists():
            continue
        df = pd.read_parquet(path)
        for i, r in df.iterrows():
            assistant = str(r["assistant"])
            # Extract simple steps / causes heuristically from assistant text
            causes = re.findall(r"^\s*\d+\.\s+(.+)$", assistant, flags=re.M)
            steps = causes[4:11] if len(causes) > 4 else causes[:6]
            if not steps:
                steps = [
                    "Confirm DTC with OBD-II scan",
                    "Inspect related system components",
                    "Repair or replace faulty part",
                    "Clear codes and verify drive cycle",
                ]
            sev = str(r.get("severity", "Medium")).lower()
            if sev not in {"low", "medium", "high", "critical"}:
                sev = "medium"
            output = {
                "fault_code": str(r["dtc_code"]),
                "diagnosis": assistant.split("\n\n")[0][:700] if assistant else str(r["dtc_code"]),
                "severity": "high" if sev == "critical" else sev,
                "parts": [str(r.get("dtc_system", "related_component"))],
                "repair_steps": [s.strip()[:200] for s in steps[:8]],
                "qa_checks": [
                    "dtc_cleared",
                    "no_pending_codes_after_drive_cycle",
                    "buyer_road_test_pass",
                ],
                "estimated_minutes": 60 if sev in {"high", "critical"} else 40,
                "confidence": 0.85,
                "buyer_advice": (
                    f"Used-vehicle tip: request repair invoice + post-repair OBD screenshot for "
                    f"{r['dtc_code']} on {r.get('vehicle', 'this vehicle')}."
                ),
            }
            rows.append(
                {
                    "id": f"DTCFT-{split}-{i}-{r['dtc_code']}",
                    "source": "automotive_dtc_finetune",
                    "vehicle": str(r.get("vehicle", "")),
                    "instruction": (
                        "You are helping a second-hand car buyer. Convert the diagnostic request "
                        "into structured repair JSON."
                    ),
                    "input": str(r["user"]),
                    "output": output,
                    "chat_system": str(r.get("system", "")),
                    "chat_assistant_raw": assistant,
                }
            )
    return rows


def from_nhtsa() -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    nhtsa_dir = RAW / "NHTSA"
    for path in sorted(nhtsa_dir.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        complaints = data.get("results") or data.get("complaints") or []
        if isinstance(data, dict) and not complaints and "count" in data:
            complaints = data.get("results", [])
        # API shape: {"count": N, "results": [...]}
        if isinstance(data, dict):
            complaints = data.get("results", complaints)
        for i, c in enumerate(complaints[:80]):
            if not isinstance(c, dict):
                continue
            comp = c.get("components") or c.get("component") or "UNKNOWN"
            summary = (
                c.get("summary")
                or c.get("complaintDescription")
                or c.get("odiNumber")
                or ""
            )
            summary = str(summary).strip()
            if len(summary) < 40:
                continue
            year = c.get("modelYear")
            make = c.get("make")
            model = c.get("model")
            products = c.get("products") or []
            if products and isinstance(products, list) and isinstance(products[0], dict):
                year = year or products[0].get("productYear") or products[0].get("modelYear")
                make = make or products[0].get("productMake") or products[0].get("make")
                model = model or products[0].get("productModel") or products[0].get("model")
            parts = path.stem.split("_")
            year = year or parts[-1]
            make = make or parts[0]
            model = model or "_".join(parts[1:-1])
            mileage = c.get("odometer") or c.get("mileage") or "unknown"
            # Use component category as fault_code (not NHTSA_ prefix) so exact-match eval is meaningful
            fault = (
                (str(comp).split(",")[0]).strip().upper().replace(" ", "_").replace("/", "_")[:48]
                or "UNKNOWN_COMPONENT"
            )
            output = {
                "fault_code": fault,
                "diagnosis": summary[:800],
                "severity": "high" if any(
                    k in summary.upper() for k in ("FIRE", "AIR BAG", "CRASH", "STALL", "BRAKE")
                )
                else "medium",
                "parts": [str(comp).split(",")[0].strip()[:80]],
                "repair_steps": [
                    "Verify complaint against NHTSA component category",
                    "Perform OEM diagnostic procedure for reported symptom",
                    "Repair or replace failed component",
                    "Document parts/labor for buyer disclosure",
                    "Clear related codes and confirm road test",
                ],
                "qa_checks": ["symptom_resolved", "no_related_dtc", "service_record_filed"],
                "estimated_minutes": 90,
                "confidence": 0.7,
                "buyer_advice": (
                    f"This issue appears in NHTSA complaints for {year} {make} {model}. "
                    "Ask for repair history and check open recalls before purchase."
                ),
            }
            rows.append(
                {
                    "id": f"NHTSA-{path.stem}-{i}",
                    "source": "nhtsa_complaints",
                    "vehicle": f"{year} {make} {model}",
                    "instruction": (
                        "A used-car shopper reports this NHTSA-style complaint. Produce structured "
                        "repair / inspection JSON."
                    ),
                    "input": (
                        f"Vehicle: {year} {make} {model}. Odometer: {mileage}. "
                        f"Component: {comp}. Complaint: {summary[:600]}"
                    ),
                    "output": output,
                }
            )
    return rows


def from_cmapss(max_per_fd: int = 400, seed: int = 42) -> List[Dict[str, Any]]:
    """Engine degradation trajectories → powertrain health language for used vehicles."""
    rng = random.Random(seed)
    rows: List[Dict[str, Any]] = []
    cols = [
        "unit",
        "cycle",
        "op1",
        "op2",
        "op3",
        *[f"s{i}" for i in range(1, 22)],
    ]
    for fd in ("FD001", "FD002", "FD003", "FD004"):
        path = RAW / "CMAPSS" / f"train_{fd}.txt"
        if not path.exists():
            continue
        df = pd.read_csv(path, sep=r"\s+", header=None, names=cols, engine="python")
        collected = []
        for unit, g in df.groupby("unit"):
            g = g.sort_values("cycle")
            max_cycle = int(g["cycle"].iloc[-1])
            # sample a few windows near end-of-life and mid-life
            for frac, band, fault, severity in [
                (0.95, "critical", "PWRTRN_WEAR_CRITICAL", "high"),
                (0.7, "degrading", "PWRTRN_WEAR_MODERATE", "medium"),
                (0.3, "healthy", "PWRTRN_HEALTH_OK", "low"),
            ]:
                idx = max(5, int(len(g) * frac) - 1)
                window = g.iloc[max(0, idx - 4) : idx + 1]
                cycle = int(window["cycle"].iloc[-1])
                rul = max_cycle - cycle
                sensor_txt = "; ".join(
                    f"cycle={int(r.cycle)} s2={r.s2:.2f} s3={r.s3:.2f} s4={r.s4:.2f} s11={r.s11:.2f}"
                    for r in window.itertuples()
                )
                steps = {
                    "healthy": [
                        "Continue routine oil/filter service",
                        "Log OBD freeze-frame baselines",
                        "Re-check at next used-car PPI",
                    ],
                    "degrading": [
                        "Perform compression / leak-down or relative compression test",
                        "Inspect intake/exhaust for restriction",
                        "Change oil and analyze for wear metals",
                        "Plan powertrain service before resale",
                    ],
                    "critical": [
                        "Do not market as turn-key without disclosure",
                        "Full powertrain diagnostic and borescope if applicable",
                        "Replace worn components or adjust sale price",
                        "Provide buyer with scan + repair estimate",
                    ],
                }[band]
                output = {
                    "fault_code": fault,
                    "diagnosis": (
                        f"CMAPSS {fd} unit {int(unit)} engine-health analogue at cycle {cycle}: "
                        f"band={band}, RUL-like score={rul}."
                    ),
                    "severity": severity,
                    "parts": [] if band == "healthy" else ["engine_wear_components"],
                    "repair_steps": steps,
                    "qa_checks": ["obd_live_data_logged", "no_misfire_counts", "oil_condition_ok"],
                    "estimated_minutes": 30 if band == "healthy" else 120,
                    "confidence": 0.8,
                    "buyer_advice": (
                        "Treat as powertrain health evidence for a used vehicle PPI; "
                        "request compression results and service history."
                    ),
                }
                collected.append(
                    {
                        "id": f"CMAPSS-{fd}-{int(unit)}-{cycle}",
                        "source": f"nasa_cmapss_{fd.lower()}",
                        "vehicle": f"engine-fleet-{fd}",
                        "instruction": (
                            "Interpret engine sensor trend for a used-vehicle powertrain inspection "
                            "and return structured JSON."
                        ),
                        "input": f"Dataset={fd}. Sensors: {sensor_txt}",
                        "output": output,
                    }
                )
        rng.shuffle(collected)
        rows.extend(collected[:max_per_fd])
    return rows


def from_ai4i() -> List[Dict[str, Any]]:
    path = RAW / "AI4I" / "ai4i2020.csv"
    df = pd.read_csv(path)
    rows: List[Dict[str, Any]] = []
    fail_cols = [
        ("TWF", "TOOL_WEAR_FAILURE", "Wear-related rotating component failure"),
        ("HDF", "HEAT_DISSIPATION_FAILURE", "Thermal / cooling path failure"),
        ("PWF", "POWER_FAILURE", "Power delivery / torque anomaly"),
        ("OSF", "OVERSTRAIN_FAILURE", "Overstrain / overload failure"),
        ("RNF", "RANDOM_FAILURE", "Random component failure"),
    ]
    # Keep failed samples + a sample of healthy
    failed = df[df["Machine failure"] == 1]
    healthy = df[df["Machine failure"] == 0].sample(n=min(400, len(df)), random_state=42)
    for _, r in pd.concat([failed, healthy]).iterrows():
        active = [c for c, code, _ in fail_cols if int(r.get(c, 0)) == 1]
        if active:
            code = next(code for c, code, _ in fail_cols if c == active[0])
            label = next(lbl for c, _, lbl in fail_cols if c == active[0])
            severity = "high"
            steps = [
                "Isolate failed subsystem using sensor thresholds",
                "Replace worn/overheated component",
                "Recalibrate process parameters",
                "Run post-repair functional test",
            ]
        else:
            code, label, severity = "MACHINE_HEALTH_OK", "No failure flag", "low"
            steps = ["Continue monitoring", "Keep service interval", "Record baseline telemetry"]
        output = {
            "fault_code": code,
            "diagnosis": (
                "{label}. Air temp={air}, process temp={proc}, rpm={rpm}, "
                "torque={torque}, tool_wear={wear}."
            ).format(
                label=label,
                air=r["Air temperature [K]"],
                proc=r["Process temperature [K]"],
                rpm=r["Rotational speed [rpm]"],
                torque=r["Torque [Nm]"],
                wear=r["Tool wear [min]"],
            ),
            "severity": severity,
            "parts": [] if severity == "low" else ["wear_component"],
            "repair_steps": steps,
            "qa_checks": ["telemetry_in_spec", "no_failure_flag"],
            "estimated_minutes": 25 if severity == "low" else 75,
            "confidence": 0.83,
            "buyer_advice": (
                "Industrial failure-mode analogue: use as structured evidence when a used vehicle "
                "shows thermal, power, or wear-related symptoms under load."
            ),
        }
        rows.append(
            {
                "id": f"AI4I-{r['UDI']}",
                "source": "uci_ai4i_2020",
                "vehicle": f"product-{r['Product ID']}",
                "instruction": (
                    "Map industrial sensor failure modes to a structured automotive-style repair JSON "
                    "for documentation in a Proof of Repair ledger."
                ),
                "input": (
                    "Type={t}, air_K={air}, proc_K={proc}, rpm={rpm}, "
                    "torque_Nm={torque}, wear_min={wear}, machine_failure={fail}"
                ).format(
                    t=r["Type"],
                    air=r["Air temperature [K]"],
                    proc=r["Process temperature [K]"],
                    rpm=r["Rotational speed [rpm]"],
                    torque=r["Torque [Nm]"],
                    wear=r["Tool wear [min]"],
                    fail=r["Machine failure"],
                ),
                "output": output,
            }
        )
    return rows


def format_sft(row: Dict[str, Any]) -> Dict[str, Any]:
    output = row["output"]
    if isinstance(output, dict):
        output = dict(output)
        output["diagnosis"] = str(output.get("diagnosis", ""))[:400]
        output["buyer_advice"] = str(output.get("buyer_advice", ""))[:220]
        for key in ("parts", "repair_steps", "qa_checks"):
            if isinstance(output.get(key), list):
                output[key] = [str(x)[:120] for x in output[key][:8]]
        assistant = _json_output(**output)
    else:
        assistant = str(output)
    text = (
        f"### System\n{SYSTEM_PROMPT}\n\n"
        f"### User\n{row['instruction']}\n\n{row['input']}\n\n"
        f"### Assistant\n{assistant}"
    )
    return {
        "id": row["id"],
        "text": text,
        "fault_code": output.get("fault_code", "") if isinstance(output, dict) else "",
        "source": row.get("source", ""),
        "vehicle": row.get("vehicle", ""),
    }


def split_rows(
    rows: List[Dict[str, Any]], seed: int = 42
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Legacy global shuffle split (kept for reproducibility of older runs)."""
    rng = random.Random(seed)
    rows = list(rows)
    rng.shuffle(rows)
    n = len(rows)
    n_train = int(0.8 * n)
    n_val = int(0.1 * n)
    return rows[:n_train], rows[n_train : n_train + n_val], rows[n_train + n_val :]


def _group_key(row: Dict[str, Any]) -> str:
    """Disjoint-split key: DTC code for OBD sources, unit for CMAPSS, else id prefix."""
    src = row.get("source", "")
    out = row.get("output") or {}
    code = str(out.get("fault_code", "")) if isinstance(out, dict) else ""
    rid = str(row.get("id", ""))
    if src in {"mechanicdb_obd2", "automotive_dtc_finetune"} and code:
        return f"dtc:{code}"
    if src == "nasa_cmapss":
        # id like CMAPSS-FD001-49-150 → unit FD001-49
        parts = rid.split("-")
        if len(parts) >= 3:
            return f"cmapss:{parts[1]}-{parts[2]}"
    if src == "nhtsa_complaints" and code:
        return f"nhtsa:{code}"
    if src == "uci_ai4i_2020" and code:
        return f"ai4i:{code}"
    return f"id:{rid}"


def stratified_disjoint_split(
    rows: List[Dict[str, Any]], seed: int = 42
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """80/10/10 with globally disjoint group keys (DTC / CMAPSS unit) to prevent leakage."""
    rng = random.Random(seed)
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        groups.setdefault(_group_key(r), []).append(r)

    # Prefer balancing rare sources: sort keys by dominant source then shuffle within buckets
    def dominant_source(items: List[Dict[str, Any]]) -> str:
        counts: Dict[str, int] = {}
        for r in items:
            s = str(r.get("source", "unknown"))
            counts[s] = counts.get(s, 0) + 1
        return max(counts, key=counts.get)

    by_dom: Dict[str, List[str]] = {}
    for k, items in groups.items():
        by_dom.setdefault(dominant_source(items), []).append(k)

    train_keys: set = set()
    val_keys: set = set()
    test_keys: set = set()
    for _src, keys in by_dom.items():
        rng.shuffle(keys)
        n = len(keys)
        n_train = max(1, int(round(0.8 * n))) if n >= 3 else max(1, n - 1 if n > 1 else n)
        n_val = int(round(0.1 * n)) if n >= 10 else (1 if n >= 5 else 0)
        if n_train + n_val >= n:
            n_val = max(0, n - n_train - 1) if n > n_train else 0
        train_keys.update(keys[:n_train])
        val_keys.update(keys[n_train : n_train + n_val])
        test_keys.update(keys[n_train + n_val :])

    train: List[Dict[str, Any]] = []
    val: List[Dict[str, Any]] = []
    test: List[Dict[str, Any]] = []
    for k, g in groups.items():
        if k in train_keys:
            train.extend(g)
        elif k in val_keys:
            val.extend(g)
        else:
            test.extend(g)

    rng.shuffle(train)
    rng.shuffle(val)
    rng.shuffle(test)
    return train, val, test


def prepare(
    seed: int = 42,
    cmapss_per_fd: int = 300,
    profile: str = "full",
    disjoint: bool = True,
) -> Dict[str, Any]:
    """
    profile:
      full  — all 5 corpora (ablation / transfer)
      dtc   — MechanicDB + DTC-FT + NHTSA only (paper main automotive claim)
    """
    buckets = {
        "mechanicdb_obd2": from_mechanicdb(),
        "automotive_dtc_finetune": from_dtc_finetune(),
        "nhtsa_complaints": from_nhtsa(),
        "nasa_cmapss": from_cmapss(max_per_fd=cmapss_per_fd, seed=seed),
        "uci_ai4i_2020": from_ai4i(),
    }
    if profile == "dtc":
        keep = {"mechanicdb_obd2", "automotive_dtc_finetune", "nhtsa_complaints"}
        buckets = {k: v for k, v in buckets.items() if k in keep}

    all_rows: List[Dict[str, Any]] = []
    counts = {}
    for k, v in buckets.items():
        counts[k] = len(v)
        all_rows.extend(v)
        print(f"[prepare] {k}: {len(v)}")

    if disjoint:
        train, val, test = stratified_disjoint_split(all_rows, seed=seed)
    else:
        train, val, test = split_rows(all_rows, seed=seed)

    PROCESSED.mkdir(parents=True, exist_ok=True)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)

    train_sft = [format_sft(r) for r in train]
    val_sft = [format_sft(r) for r in val]
    test_sft = [format_sft(r) for r in test]

    write_jsonl(PROCESSED / "train.jsonl", train_sft)
    write_jsonl(PROCESSED / "val.jsonl", val_sft)
    write_jsonl(PROCESSED / "test.jsonl", test_sft)
    write_jsonl(PROCESSED / "train_raw.jsonl", train)
    write_jsonl(PROCESSED / "val_raw.jsonl", val)
    write_jsonl(PROCESSED / "test_raw.jsonl", test)

    # Always also emit DTC-only test slice from current test (for paper table)
    test_dtc = [r for r in test if r.get("source") in {
        "mechanicdb_obd2", "automotive_dtc_finetune", "nhtsa_complaints"
    }]
    write_jsonl(PROCESSED / "test_raw_dtc.jsonl", test_dtc)

    dataset_root = merkle_root_of_strings([json.dumps(r, sort_keys=True) for r in train_sft])
    manifest = {
        "domain": "second_hand_vehicle_proof_of_repair",
        "profile": profile,
        "disjoint_split": disjoint,
        "counts_by_source": counts,
        "train": len(train_sft),
        "val": len(val_sft),
        "test": len(test_sft),
        "test_dtc": len(test_dtc),
        "seed": seed,
        "dataset_merkle_root": dataset_root,
        "datasets": list(buckets.keys()),
        "papers": ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"],
    }
    (ARTIFACTS / "dataset_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--cmapss-per-fd", type=int, default=300)
    parser.add_argument("--profile", choices=("full", "dtc"), default="dtc")
    parser.add_argument("--no-disjoint", action="store_true")
    args = parser.parse_args()
    prepare(
        seed=args.seed,
        cmapss_per_fd=args.cmapss_per_fd,
        profile=args.profile,
        disjoint=not args.no_disjoint,
    )


if __name__ == "__main__":
    main()
