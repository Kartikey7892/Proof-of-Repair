#!/bin/bash
# Deploy ProofOfRepair to Sepolia (needs funded key + RPC in .env)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ ! -f .env ]; then
  echo "Create .env from .env.example with SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY"
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a
if [ -z "${SEPOLIA_RPC_URL}" ] || [ -z "${DEPLOYER_PRIVATE_KEY}" ]; then
  echo "SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY required in .env"
  exit 1
fi
cd chain
npx hardhat compile
npx hardhat run scripts/deploy.js --network sepolia
echo "Sepolia deploy written to artifacts/chain_config.json"
echo "Restart the server: cd server && npm start"
