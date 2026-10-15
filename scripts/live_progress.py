#!/usr/bin/env python3
"""Live dashboard — shows real train step/loss (ignores dataset Map bars)."""
from __future__ import annotations

import os
import pathlib
import re
import subprocess
import time
from datetime import datetime

BLOB = (
    pathlib.Path.home()
    / ".cache/huggingface/hub/models--TinyLlama--TinyLlama-1.1B-Chat-v1.0/blobs"
)
HASH = "6e6001da2106d4757498752a021df6c2bdc332c650aae4bae6b0c004dcf14933"
EXPECTED = 2200119864
ROOT = pathlib.Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "artifacts/adapters/vehicle-lora/adapter_config.json"
TRAIN_LOG = ROOT / "artifacts/finetune_train.log"
MANIFEST = ROOT / "artifacts/vehicle_batch_manifest.json"
TOTAL_STEPS = 120
PIDFILE = ROOT / "artifacts/train.pid"


def download_size():
    done = BLOB / HASH
    if done.exists() and done.stat().st_size > EXPECTED * 0.9:
        return done.stat().st_size, "COMPLETE"
    part = BLOB / f"{HASH}.partial"
    if part.exists():
        return part.stat().st_size, "DOWNLOADING"
    return 0, "WAITING"


def bar(pct: float, width: int = 36) -> str:
    filled = int(width * min(max(pct, 0), 100) / 100)
    return "█" * filled + "░" * (width - filled)


def train_running() -> tuple[bool, str]:
    # Prefer pidfile written by detached trainer
    if PIDFILE.exists():
        try:
            pid = int(PIDFILE.read_text().strip())
            # check alive
            os.kill(pid, 0)
            # get cpu
            try:
                out = subprocess.check_output(
                    ["ps", "-p", str(pid), "-o", "%cpu=,command="], text=True
                ).strip()
            except Exception:
                out = f"pid={pid}"
            return True, f"{pid} {out}"[:110]
        except (OSError, ValueError):
            pass
    try:
        out = subprocess.check_output(["ps", "ax", "-o", "pid=, %cpu=, command="], text=True)
    except Exception:
        return False, ""
    for line in out.splitlines():
        if "src.llm.finetune_lora" not in line:
            continue
        if any(x in line for x in ("node", "datacloud_telemetry", "live_progress", "pgrep", "bash -c")):
            continue
        if "Python" not in line and "python" not in line:
            continue
        return True, line.strip()[:110]
    return False, ""


def parse_train_status() -> dict:
    info = {"step": 0, "total": TOTAL_STEPS, "loss": None, "raw": "", "speed": ""}
    if not TRAIN_LOG.exists():
        return info
    raw = TRAIN_LOG.read_bytes().decode("utf-8", errors="ignore")
    chunks = re.split(r"[\r\n]+", raw)
    step_re = re.compile(r"(?<!\d)(\d+)\s*/\s*(\d+)\s*\[")
    loss_re = re.compile(r"'loss'\s*:\s*'?([0-9.]+)'?")
    best_step = 0
    best_total = TOTAL_STEPS
    best_loss = None
    best_raw = ""
    best_speed = ""
    for c in chunks:
        c = c.strip()
        if not c:
            continue
        if c.startswith("Map:") or "examples/s" in c or "Loading weights" in c:
            continue
        if "'loss'" in c:
            lm = loss_re.search(c)
            if lm:
                best_loss = float(lm.group(1))
                best_raw = c[-140:]
            continue
        m = step_re.search(c)
        if not m:
            continue
        step, total = int(m.group(1)), int(m.group(2))
        if total < 20 or total > 500:
            continue
        if "s/it" not in c and "it/s" not in c:
            continue
        if step >= best_step:
            best_step, best_total = step, total
            best_raw = c[-140:]
            sp = re.search(r"([0-9.]+s/it|[0-9.]+it/s)", c)
            if sp:
                best_speed = sp.group(1)
    info.update(
        step=best_step,
        total=best_total,
        loss=best_loss,
        raw=best_raw,
        speed=best_speed,
    )
    return info


def main() -> None:
    prev_step = -1
    start = time.time()
    stall_since = time.time()
    while True:
        dl_size, dl_state = download_size()
        dl_pct = min(100.0, 100.0 * dl_size / EXPECTED)
        running, proc = train_running()
        st = parse_train_status()
        adapter_ok = ADAPTER.exists()
        demo_ok = MANIFEST.exists()

        if st["step"] != prev_step:
            stall_since = time.time()
            prev_step = st["step"]
        stalled_s = time.time() - stall_since

        if dl_state != "COMPLETE":
            phase = "1/3 DOWNLOADING"
        elif adapter_ok and demo_ok:
            phase = "DONE"
        elif adapter_ok:
            phase = "3/3 VIN PoR demo"
        elif running:
            phase = "2/3 FINE-TUNING"
        else:
            phase = "2/3 TRAIN NOT RUNNING"

        train_pct = 100.0 * st["step"] / max(st["total"], 1)
        eta = "—"
        if st.get("speed") and st["speed"].endswith("s/it") and st["step"] < st["total"]:
            try:
                sec = float(st["speed"].replace("s/it", ""))
                eta = f"{(st['total'] - st['step']) * sec / 60:.1f} min"
            except ValueError:
                pass

        os.system("clear")
        print("=" * 72)
        print(" VEHICLE PoR — LIVE STEP/LOSS")
        print(f" {datetime.now():%H:%M:%S}   wall {(time.time()-start)/60:.1f} min")
        print("=" * 72)
        print(f" Phase     : {phase}")
        print(f" Download  : [{bar(dl_pct)}] {dl_pct:5.1f}%  {dl_state}")
        print(
            f" Train     : [{bar(train_pct)}] "
            f"{st['step']}/{st['total']}  ({train_pct:.1f}%)   ETA {eta}"
        )
        print(f" Loss      : {st['loss'] if st['loss'] is not None else '— (appears after step 1)'}")
        print(f" Speed     : {st.get('speed') or '—'}")
        print(f" Process   : {'RUNNING' if running else 'NOT RUNNING'}")
        if proc:
            print(f"             {proc}")
        print(f" Step age  : {stalled_s:.0f}s since last step bump")
        print(f" Adapter   : {'READY' if adapter_ok else 'pending'}")
        print(f" Demo      : {'READY' if demo_ok else 'pending'}")
        print("-" * 72)
        print(f" Last: {st['raw'] or '(waiting for trainer step lines…)'}")
        print("=" * 72)
        if phase == "DONE":
            print("\nAll complete.")
            break
        time.sleep(2)


if __name__ == "__main__":
    main()
