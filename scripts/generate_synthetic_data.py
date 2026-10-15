#!/usr/bin/env python3
"""Generate Synthetic Appliance Repair Corpus (SARC) for SFT."""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "synthetic" / "sarc_repairs.jsonl"

APPLIANCES = {
    "smartphone": {
        "symptoms": [
            "battery drains 40% overnight and gets warm near camera module",
            "screen flickers when brightness changes; faint green line on OLED",
            "Wi-Fi drops every few minutes even with strong RSSI",
            "phone overheats during video calls and throttles CPU",
            "touch unresponsive in lower third of display after drop",
        ],
        "faults": [
            ("BAT_DEGRADE_HIGH", "medium", ["battery_pack"], 45),
            ("DISP_PANEL_FAULT", "high", ["display_assembly"], 60),
            ("NET_RADIO_UNSTABLE", "medium", ["wifi_module", "antenna_cable"], 40),
            ("THERMAL_THROTTLE", "medium", ["thermal_paste"], 50),
            ("DISP_PANEL_FAULT", "high", ["display_assembly"], 55),
        ],
    },
    "laptop": {
        "symptoms": [
            "fans spin at 100% under light load; chassis near vents is very hot",
            "battery percentage jumps randomly; only works on AC",
            "intermittent Wi-Fi disconnects after lid open/close",
            "display shows backlight bleed and occasional black flashes",
            "system shuts down during gaming with thermal warning",
        ],
        "faults": [
            ("THERMAL_THROTTLE", "medium", ["thermal_paste", "cooling_fan"], 55),
            ("BAT_DEGRADE_HIGH", "medium", ["battery_pack"], 50),
            ("NET_RADIO_UNSTABLE", "medium", ["wifi_module"], 35),
            ("DISP_PANEL_FAULT", "high", ["display_assembly"], 70),
            ("THERMAL_THROTTLE", "high", ["cooling_fan"], 60),
        ],
    },
    "smart_tv": {
        "symptoms": [
            "HDMI input flickers; apps crash when launching 4K streams",
            "TV overheats and reboots after 90 minutes of use",
            "Wi-Fi smart features drop while Ethernet works fine",
            "vertical lines on panel after power surge",
            "remote pairs but voice assistant fails intermittently",
        ],
        "faults": [
            ("DISP_PANEL_FAULT", "high", ["tcon_board"], 80),
            ("THERMAL_THROTTLE", "medium", ["cooling_fan"], 45),
            ("NET_RADIO_UNSTABLE", "medium", ["wifi_module"], 40),
            ("DISP_PANEL_FAULT", "high", ["display_assembly"], 120),
            ("NET_RADIO_UNSTABLE", "low", ["wifi_module"], 30),
        ],
    },
    "washing_machine": {
        "symptoms": [
            "water leaks from door during spin; error E30 shown",
            "drum unbalanced and pump makes grinding noise",
            "machine will not drain; water remains after cycle",
            "overheats motor during heavy load cycle",
            "Wi-Fi module offline; local controls still work",
        ],
        "faults": [
            ("APPL_WATER_PATH", "high", ["door_seal"], 70),
            ("APPL_WATER_PATH", "high", ["drain_pump"], 65),
            ("APPL_WATER_PATH", "high", ["drain_pump"], 60),
            ("THERMAL_THROTTLE", "medium", ["motor_bearing"], 90),
            ("NET_RADIO_UNSTABLE", "low", ["wifi_module"], 25),
        ],
    },
    "refrigerator": {
        "symptoms": [
            "fridge warm; freezer cold; compressor runs continuously",
            "water dispenser leaks onto floor",
            "ice maker jammed; unusual clicking every minute",
            "smart temperature app reports sensor mismatch",
            "unit vibrates loudly and trips breaker occasionally",
        ],
        "faults": [
            ("THERMAL_THROTTLE", "high", ["evaporator_fan"], 75),
            ("APPL_WATER_PATH", "medium", ["water_valve"], 50),
            ("GEN_NEEDS_INSPECTION", "medium", ["ice_maker_assembly"], 55),
            ("GEN_NEEDS_INSPECTION", "low", ["temp_sensor"], 35),
            ("THERMAL_THROTTLE", "high", ["compressor_relay"], 90),
        ],
    },
    "router": {
        "symptoms": [
            "5 GHz SSID disappears under load; 2.4 GHz remains",
            "device reboots nightly; logs show thermal watchdog",
            "WAN LED flaps; packet loss 15%",
            "mesh node frequently loses backhaul",
            "Ethernet ports 3-4 negotiate only at 100 Mbps",
        ],
        "faults": [
            ("NET_RADIO_UNSTABLE", "medium", ["wifi_module"], 40),
            ("THERMAL_THROTTLE", "medium", ["thermal_pad"], 35),
            ("NET_RADIO_UNSTABLE", "high", ["wan_phy"], 50),
            ("NET_RADIO_UNSTABLE", "medium", ["wifi_module"], 45),
            ("GEN_NEEDS_INSPECTION", "medium", ["ethernet_phy"], 40),
        ],
    },
}

DIAGNOSIS_TMPL = {
    "BAT_DEGRADE_HIGH": "Likely aged or defective battery with elevated self-discharge / unstable SOC reporting.",
    "DISP_PANEL_FAULT": "Display panel, TCON, or flex assembly fault consistent with visual artifacts or damage.",
    "THERMAL_THROTTLE": "Thermal dissipation path degraded causing elevated temperatures and protective throttling.",
    "NET_RADIO_UNSTABLE": "Network radio / PHY / antenna path unstable under observed conditions.",
    "APPL_WATER_PATH": "Water path component fault (seal, pump, valve, or hose) indicated by leak/drain symptoms.",
    "GEN_NEEDS_INSPECTION": "Symptoms require structured inspection; no single high-confidence fault yet.",
}

STEPS = {
    "BAT_DEGRADE_HIGH": [
        "Run battery health / impedance test",
        "Replace battery pack",
        "Calibrate state-of-charge",
        "Verify idle drain overnight",
    ],
    "DISP_PANEL_FAULT": [
        "Inspect panel and signal cable / TCON",
        "Replace faulty display assembly or board",
        "Recalibrate touch / image settings",
        "Run pixel and UI QA suite",
    ],
    "THERMAL_THROTTLE": [
        "Clean dust from vents and heatsink",
        "Replace thermal interface material",
        "Test or replace cooling components",
        "Validate temperatures under sustained load",
    ],
    "NET_RADIO_UNSTABLE": [
        "Update network firmware",
        "Reseat antenna / RF connectors",
        "Replace Wi-Fi / PHY module if needed",
        "Run connectivity soak test",
    ],
    "APPL_WATER_PATH": [
        "Inspect hoses, seals, and valves",
        "Clear filters and drain path",
        "Replace failed pump/seal/valve",
        "Run leak and cycle QA",
    ],
    "GEN_NEEDS_INSPECTION": [
        "Collect symptom timeline and error codes",
        "Run built-in self-tests",
        "Capture sensor snapshots",
        "Escalate if unresolved",
    ],
}

QA = {
    "BAT_DEGRADE_HIGH": ["idle_drain < 5%/8h", "thermal_idle_ok"],
    "DISP_PANEL_FAULT": ["dead_pixel_scan_pass", "touch_grid_pass"],
    "THERMAL_THROTTLE": ["load_temp_within_spec", "fan_rpm_ok"],
    "NET_RADIO_UNSTABLE": ["rssi_stable", "ping_loss < 1%"],
    "APPL_WATER_PATH": ["no_leak_on_fill", "spin_balance_ok"],
    "GEN_NEEDS_INSPECTION": ["self_test_logged"],
}


def make_example(idx: int, rng: random.Random) -> dict:
    appliance = rng.choice(list(APPLIANCES.keys()))
    spec = APPLIANCES[appliance]
    s_idx = rng.randrange(len(spec["symptoms"]))
    symptom = spec["symptoms"][s_idx]
    fault_code, severity, parts, minutes = spec["faults"][s_idx]
    # occasional paraphrase noise
    if rng.random() < 0.3:
        symptom = symptom + " Customer reports issue for " + rng.choice(
            ["2 days", "1 week", "3 weeks", "since last update"]
        )

    instruction = (
        "Diagnose the appliance fault and propose a structured repair plan as JSON "
        "with fields fault_code, diagnosis, severity, parts, repair_steps, qa_checks, "
        "estimated_minutes, confidence."
    )
    input_text = f"Device type: {appliance}. Symptoms: {symptom}"
    output = {
        "fault_code": fault_code,
        "diagnosis": DIAGNOSIS_TMPL[fault_code],
        "severity": severity,
        "parts": parts,
        "repair_steps": STEPS[fault_code],
        "qa_checks": QA[fault_code],
        "estimated_minutes": minutes + rng.randint(-5, 5),
        "confidence": round(rng.uniform(0.72, 0.93), 2),
    }
    return {
        "id": f"SARC-{idx:05d}",
        "appliance": appliance,
        "instruction": instruction,
        "input": input_text,
        "output": output,
        "source": "sarc",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=500)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        for i in range(args.n):
            f.write(json.dumps(make_example(i, rng), ensure_ascii=False) + "\n")
    print(f"Wrote {args.n} examples → {args.out}")


if __name__ == "__main__":
    main()
