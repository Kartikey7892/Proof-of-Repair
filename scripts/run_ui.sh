#!/bin/bash
# Launch Proof-of-Repair web UI + API (Node.js / Express).
# Optional: start the LoRA inference sidecar first with `python ml/inference_server.py`.
set -euo pipefail
cd "$(dirname "$0")/../server"
[ -d node_modules ] || npm install
echo "Open http://127.0.0.1:${PORT:-8000}"
exec npm start
