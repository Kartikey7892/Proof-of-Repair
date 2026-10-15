"""Inference sidecar for the fine-tuned LoRA engines.

The Express backend (server/) cannot run PyTorch / MLX, so it calls this tiny
stdlib HTTP server for the `tinyllama` and `mistral` engines. Everything else
(proofs, Merkle anchoring, PostgreSQL, analytics) lives in Node.

    python ml/inference_server.py            # listens on 127.0.0.1:8001
    INFERENCE_URL=http://127.0.0.1:8001       # (server default)

GET  /health    -> {"engines": {"tinyllama": bool, "mistral": bool}}
POST /diagnose  {engine, vehicle, symptoms, dtc_codes, sensor_notes}
             -> {"report": {...}, "model": {model_name, model_version, adapter_hash, dataset_merkle_root, framework}}
"""

from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

ADAPTERS = ROOT / "artifacts" / "adapters"
_engines: Dict[str, Any] = {}
_lock = threading.Lock()


def _tinyllama_dir() -> Path:
    dtc = ADAPTERS / "vehicle-lora-dtc"
    return dtc if (dtc / "adapter_config.json").exists() else ADAPTERS / "vehicle-lora"


def availability() -> Dict[str, bool]:
    return {
        "tinyllama": (_tinyllama_dir() / "adapter_config.json").exists(),
        "mistral": (ADAPTERS / "mistral-mlx-lora" / "adapters.safetensors").exists(),
    }


def get_engine(name: str):
    with _lock:  # model load is slow and not thread-safe; serialize it
        if name in _engines:
            return _engines[name]
        if name == "mistral":
            from src.llm.mistral_mlx_infer import MistralMLXEngine

            eng = MistralMLXEngine(adapter_path=ADAPTERS / "mistral-mlx-lora")
            framework = "mlx+lora"
        else:
            from src.llm.infer import DiagnosticEngine

            eng = DiagnosticEngine(adapter_dir=_tinyllama_dir())
            framework = "transformers+peft"
        eng._framework = framework
        _engines[name] = eng
        return eng


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: Dict[str, Any]) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"engines": availability()})
        else:
            self._send(404, {"detail": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/diagnose":
            self._send(404, {"detail": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
            name = str(req.get("engine") or "tinyllama").lower()
            if name not in ("tinyllama", "mistral"):
                self._send(400, {"detail": f"unknown engine {name}"})
                return
            if not availability()[name]:
                self._send(400, {"detail": f"{name} adapter not found under artifacts/adapters/"})
                return
            eng = get_engine(name)
            report = eng.diagnose(
                vehicle=str(req.get("vehicle", "")),
                symptoms=str(req.get("symptoms", "")),
                dtc_codes=str(req.get("dtc_codes", "")),
                sensor_notes=str(req.get("sensor_notes", "")),
            )
            self._send(
                200,
                {
                    "report": report.to_dict(),
                    "model": {
                        "model_name": eng.model_name,
                        "model_version": eng.model_version,
                        "adapter_hash": getattr(eng, "adapter_hash", "") or "",
                        "dataset_merkle_root": getattr(eng, "dataset_merkle_root", "") or "",
                        "framework": getattr(eng, "_framework", "transformers+peft"),
                    },
                },
            )
        except Exception as e:  # surface model errors to the API caller
            self._send(500, {"detail": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[inference] " + (fmt % args) + "\n")


def main() -> None:
    host = os.environ.get("INFERENCE_HOST", "127.0.0.1")
    port = int(os.environ.get("INFERENCE_PORT", "8001"))
    print(f"[inference] engines available: {availability()}")
    print(f"[inference] listening on http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
