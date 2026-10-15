/**
 * EVM anchoring of Merkle roots via ProofOfRepair.sol.
 *  - EvmLedger: live JSON-RPC (local Hardhat / Sepolia) using ethers v6,
 *    configured by artifacts/chain_config.json (written by scripts/start_live_chain.sh).
 *  - InMemoryLedger: simulator mirroring the contract's rules.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, getAddress, type Signer } from "ethers";

export interface Ledger {
  anchorMerkleRoot(rootHex: string, batchId: string, metaUri?: string): Promise<Record<string, unknown>>;
  isRootAnchored(rootHex: string): Promise<boolean>;
  status(): Promise<Record<string, unknown>>;
}

const to32 = (rootHex: string) => {
  const h = rootHex.startsWith("0x") ? rootHex.slice(2) : rootHex;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("merkle root must be 32-byte hex");
  return "0x" + h.toLowerCase();
};

export class InMemoryLedger implements Ledger {
  private anchors = new Map<string, Record<string, unknown>>();
  private batchRoot = new Map<string, string>();

  /** @param stateFile optional JSON file so simulated anchors survive restarts. */
  constructor(
    private stateFile: string | null = null,
    private submitter = "0xCloudPoRService",
  ) {
    if (stateFile && existsSync(stateFile)) {
      try {
        for (const rec of JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, any>[]) {
          this.anchors.set(rec.merkle_root, rec);
          this.batchRoot.set(rec.batch_id, rec.merkle_root);
        }
      } catch (e) {
        console.warn(`[ledger] ignoring unreadable simulator state ${stateFile}: ${(e as Error).message}`);
      }
    }
  }

  private persist() {
    if (!this.stateFile) return;
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify([...this.anchors.values()], null, 2));
  }

  async anchorMerkleRoot(rootHex: string, batchId: string, metaUri = "") {
    if (!rootHex || /^0+$/.test(rootHex)) throw new Error("empty root");
    if (this.anchors.has(rootHex)) throw new Error("root already anchored");
    if (this.batchRoot.has(batchId)) throw new Error("batch already used");
    const rec = {
      merkle_root: rootHex,
      batch_id: batchId,
      meta_uri: metaUri,
      submitter: this.submitter,
      anchored_at: Date.now() / 1000,
      tx_hash: "0x" + randomBytes(16).toString("hex"),
      mode: "in_memory_simulator",
    };
    this.anchors.set(rootHex, rec);
    this.batchRoot.set(batchId, rootHex);
    this.persist();
    return rec;
  }

  async isRootAnchored(rootHex: string) {
    return this.anchors.has(rootHex);
  }

  async status() {
    return {
      mode: "in_memory_simulator",
      anchors: this.anchors.size,
      persisted: Boolean(this.stateFile),
      note: "Run bash scripts/start_live_chain.sh for a real local EVM",
    };
  }
}

interface ChainConfig {
  rpc_url: string;
  chain_id: number | string;
  network?: string;
  contract_address: string;
  abi: unknown[];
  deployer?: string;
  private_key?: string;
  explorer_tx_prefix?: string;
  explorer_address_prefix?: string;
}

export class EvmLedger implements Ledger {
  private constructor(
    private cfg: ChainConfig,
    private provider: JsonRpcProvider,
    private signer: Signer,
    private from: string,
    private signMode: "unlocked" | "private_key",
    private contract: Contract,
  ) {}

  static async connect(configPath: string): Promise<EvmLedger> {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as ChainConfig;
    const chainId = Number(cfg.chain_id);
    const provider = new JsonRpcProvider(cfg.rpc_url, chainId, { staticNetwork: true });
    await provider.getBlockNumber(); // throws if the RPC is down

    let signer: Signer;
    let signMode: "unlocked" | "private_key";
    const accounts: string[] = chainId === 31337 ? await provider.send("eth_accounts", []) : [];
    const deployer = cfg.deployer ?? accounts[0];
    if (chainId === 31337 && accounts[0] && deployer && getAddress(deployer) === getAddress(accounts[0])) {
      signer = await provider.getSigner(accounts[0]);
      signMode = "unlocked";
    } else {
      if (!cfg.private_key) throw new Error("chain_config.json has no private_key for a non-local chain");
      const pk = cfg.private_key.startsWith("0x") ? cfg.private_key : `0x${cfg.private_key}`;
      signer = new Wallet(pk, provider);
      signMode = "private_key";
    }
    const from = await signer.getAddress();
    const contract = new Contract(getAddress(cfg.contract_address), cfg.abi as any, signer);
    return new EvmLedger(cfg, provider, signer, from, signMode, contract);
  }

  private get network() {
    return this.cfg.network ?? "unknown";
  }

  async status() {
    const [block, balance] = await Promise.all([
      this.provider.getBlockNumber(),
      this.provider.getBalance(this.from),
    ]);
    return {
      mode: "live_evm",
      network: this.network,
      chain_id: Number(this.cfg.chain_id),
      rpc_url: this.cfg.rpc_url,
      contract_address: this.cfg.contract_address,
      submitter: this.from,
      sign_mode: this.signMode,
      block_number: block,
      connected: true,
      balance_wei: balance.toString(),
      explorer_address: this.cfg.explorer_address_prefix
        ? `${this.cfg.explorer_address_prefix}${this.cfg.contract_address}`
        : null,
    };
  }

  async isRootAnchored(rootHex: string) {
    return Boolean(await this.contract.getFunction("isRootAnchored")(to32(rootHex)));
  }

  async anchorMerkleRoot(rootHex: string, batchId: string, metaUri = "") {
    const root = to32(rootHex);
    if (await this.isRootAnchored(root)) throw new Error("root already anchored on-chain");
    const tx = await this.contract.getFunction("anchorMerkleRoot")(root, batchId, metaUri, { gasLimit: 500_000 });
    const receipt = await tx.wait(1, 180_000);
    if (!receipt || receipt.status !== 1) throw new Error(`on-chain anchor failed: ${tx.hash}`);
    const onchain = await this.contract.getFunction("getAnchor")(root);
    return {
      merkle_root: root.slice(2),
      batch_id: batchId,
      meta_uri: metaUri,
      submitter: this.from,
      anchored_at: Number(onchain[1]),
      tx_hash: receipt.hash,
      block_number: receipt.blockNumber,
      network: this.network,
      chain_id: Number(this.cfg.chain_id),
      contract_address: this.cfg.contract_address,
      explorer_url: this.cfg.explorer_tx_prefix ? `${this.cfg.explorer_tx_prefix}${receipt.hash}` : null,
      mode: "live_evm",
    };
  }
}

/** Prefer the live EVM config; fall back to the (file-persisted) simulator. */
export async function loadLedger(configPath: string, simStateFile: string | null = null): Promise<Ledger> {
  if (existsSync(configPath)) {
    try {
      return await EvmLedger.connect(configPath);
    } catch (e) {
      console.warn(`[ledger] live EVM unavailable (${(e as Error).message}); using simulator`);
    }
  }
  return new InMemoryLedger(simStateFile);
}
