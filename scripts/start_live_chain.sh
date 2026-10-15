#!/bin/bash
# Keep local Hardhat EVM running + deploy ProofOfRepair
set -e
ROOT="/Users/shivansh/Desktop/proof of repair"
cd "$ROOT/chain"

npx hardhat compile

if ! curl -s -X POST http://127.0.0.1:8545 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -q 0x7a69; then
  echo "Starting Hardhat node in Terminal…"
  osascript <<APPLESCRIPT
tell application "Terminal"
  do script "cd '$ROOT/chain' && npx hardhat node --hostname 127.0.0.1 --port 8545 2>&1 | tee '$ROOT/artifacts/hardhat_node.log'"
end tell
APPLESCRIPT
  for i in $(seq 1 40); do
    if curl -s -X POST http://127.0.0.1:8545 \
      -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -q 0x7a69; then
      break
    fi
    sleep 0.5
  done
fi

npx hardhat run scripts/deploy.js --network localhost
echo "Live local EVM ready → artifacts/chain_config.json"
echo "Restart UI/API to pick up ledger: bash scripts/run_ui.sh"
