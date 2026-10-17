#!/bin/bash
# Start a local Hardhat EVM (if not already running) and deploy ProofOfRepair.
# Writes artifacts/chain_config.json, which the Node server picks up on restart.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/chain"
[ -d node_modules ] || npm install

npx hardhat compile

chain_up() {
  curl -s -X POST http://127.0.0.1:8545 \
    -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -q 0x7a69
}

if ! chain_up; then
  echo "Starting Hardhat node in the background (log: artifacts/hardhat_node.log)…"
  nohup npx hardhat node --hostname 127.0.0.1 --port 8545 > "$ROOT/artifacts/hardhat_node.log" 2>&1 &
  for i in $(seq 1 60); do
    chain_up && break
    sleep 0.5
  done
  chain_up || { echo "Hardhat node did not start; see artifacts/hardhat_node.log"; exit 1; }
fi

npx hardhat run scripts/deploy.js --network localhost
echo "Live local EVM ready → artifacts/chain_config.json"
echo "Restart the server to pick it up: cd server && npm start"
