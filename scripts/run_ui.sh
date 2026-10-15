#!/bin/bash
# Launch Proof-of-Repair web UI + API
cd "/Users/shivansh/Desktop/proof of repair"
source .venv/bin/activate
export PYTHONUNBUFFERED=1
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
echo "Open http://127.0.0.1:8000"
exec uvicorn src.cloud.api:app --host 127.0.0.1 --port 8000
