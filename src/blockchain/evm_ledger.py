"""Live EVM ledger — calls deployed ProofOfRepair.sol via JSON-RPC."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional

from web3 import Web3

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "artifacts" / "chain_config.json"


def _normalize_root(root_hex: str) -> bytes:
    h = root_hex[2:] if root_hex.startswith("0x") else root_hex
    if len(h) != 64:
        raise ValueError("merkle root must be 32-byte hex")
    return bytes.fromhex(h)


def _to_tx_hex(tx_hash) -> str:
    if hasattr(tx_hash, "hex"):
        h = tx_hash.hex()
    else:
        h = Web3.to_hex(tx_hash)
    return h if h.startswith("0x") else "0x" + h


class Web3Ledger:
    """Anchors Merkle roots on a live EVM (Hardhat local / Sepolia)."""

    def __init__(self, config_path: Path | str | None = None):
        path = Path(config_path) if config_path else DEFAULT_CONFIG
        if not path.exists():
            raise FileNotFoundError(
                f"Missing {path}. Run: bash scripts/start_live_chain.sh"
            )
        self.config = json.loads(path.read_text(encoding="utf-8"))
        self.rpc_url = self.config["rpc_url"]
        self.chain_id = int(self.config["chain_id"])
        self.network = self.config.get("network", "unknown")
        self.w3 = Web3(Web3.HTTPProvider(self.rpc_url, request_kwargs={"timeout": 60}))
        if self.chain_id in {11155111, 80001, 137}:
            try:
                from web3.middleware import ExtraDataToPOAMiddleware

                self.w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
            except Exception:
                pass
        if not self.w3.is_connected():
            raise ConnectionError(f"Cannot connect to RPC {self.rpc_url}")

        self.contract = self.w3.eth.contract(
            address=Web3.to_checksum_address(self.config["contract_address"]),
            abi=self.config["abi"],
        )
        self.explorer_tx_prefix = self.config.get("explorer_tx_prefix")
        self.explorer_address_prefix = self.config.get("explorer_address_prefix")

        # Prefer unlocked RPC account on local Hardhat; else sign with private key
        self.account = None
        self.from_address = None
        accounts = list(self.w3.eth.accounts)
        deployer = Web3.to_checksum_address(
            self.config.get("deployer") or (accounts[0] if accounts else "0x0")
        )
        if accounts and deployer.lower() == accounts[0].lower() and self.chain_id == 31337:
            self.from_address = accounts[0]
            self._sign_mode = "unlocked"
        else:
            pk = self.config.get("private_key") or ""
            if not pk.startswith("0x"):
                pk = "0x" + pk
            self.account = self.w3.eth.account.from_key(pk)
            self.from_address = self.account.address
            self._sign_mode = "private_key"

    def status(self) -> Dict[str, Any]:
        return {
            "mode": "live_evm",
            "network": self.network,
            "chain_id": self.chain_id,
            "rpc_url": self.rpc_url,
            "contract_address": self.config["contract_address"],
            "submitter": self.from_address,
            "sign_mode": self._sign_mode,
            "block_number": self.w3.eth.block_number,
            "connected": True,
            "balance_wei": int(self.w3.eth.get_balance(self.from_address)),
            "explorer_address": (
                f"{self.explorer_address_prefix}{self.config['contract_address']}"
                if self.explorer_address_prefix
                else None
            ),
        }

    def _send(self, fn) -> Any:
        if self._sign_mode == "unlocked":
            tx_hash = fn.transact({"from": self.from_address, "gas": 500_000})
            return self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)

        nonce = self.w3.eth.get_transaction_count(self.from_address)
        tx = fn.build_transaction(
            {
                "from": self.from_address,
                "nonce": nonce,
                "chainId": self.chain_id,
                "gas": 500_000,
            }
        )
        try:
            tip = self.w3.eth.max_priority_fee
            base = self.w3.eth.get_block("latest")["baseFeePerGas"]
            tx["maxPriorityFeePerGas"] = tip
            tx["maxFeePerGas"] = base * 2 + tip
        except Exception:
            tx["gasPrice"] = self.w3.eth.gas_price
        signed = self.account.sign_transaction(tx)
        raw = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        tx_hash = self.w3.eth.send_raw_transaction(raw)
        return self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)

    def anchor_merkle_root(
        self, root_hex: str, batch_id: str, meta_uri: str = ""
    ) -> Dict[str, Any]:
        root = _normalize_root(root_hex)
        if self.contract.functions.isRootAnchored(root).call():
            raise ValueError("root already anchored on-chain")

        fn = self.contract.functions.anchorMerkleRoot(root, batch_id, meta_uri or "")
        receipt = self._send(fn)
        if receipt.status != 1:
            raise RuntimeError(f"on-chain anchor failed: {_to_tx_hex(receipt.transactionHash)}")

        onchain = self.contract.functions.getAnchor(root).call()
        tx_hex = _to_tx_hex(receipt.transactionHash)
        plain_root = root_hex[2:] if root_hex.startswith("0x") else root_hex
        return {
            "merkle_root": plain_root,
            "batch_id": batch_id,
            "meta_uri": meta_uri,
            "submitter": self.from_address,
            "anchored_at": float(onchain[1]),
            "tx_hash": tx_hex,
            "block_number": receipt.blockNumber,
            "network": self.network,
            "chain_id": self.chain_id,
            "contract_address": self.config["contract_address"],
            "explorer_url": (
                f"{self.explorer_tx_prefix}{tx_hex}" if self.explorer_tx_prefix else None
            ),
            "mode": "live_evm",
        }

    def is_root_anchored(self, root_hex: str) -> bool:
        return bool(self.contract.functions.isRootAnchored(_normalize_root(root_hex)).call())

    def get_anchor(self, root_hex: str) -> Optional[Dict[str, Any]]:
        root = _normalize_root(root_hex)
        if not self.contract.functions.isRootAnchored(root).call():
            return None
        a = self.contract.functions.getAnchor(root).call()
        return {
            "merkle_root": a[0].hex(),
            "anchored_at": float(a[1]),
            "batch_id": a[2],
            "meta_uri": a[3],
            "submitter": a[4],
        }


def load_ledger(config_path: Path | None = None):
    """Prefer live EVM config; fall back to in-memory simulator."""
    path = config_path or DEFAULT_CONFIG
    if path.exists():
        try:
            return Web3Ledger(path)
        except Exception as e:
            print(f"[ledger] live EVM unavailable ({e}); using InMemoryLedger")
    from src.blockchain.ledger import InMemoryLedger

    return InMemoryLedger()
