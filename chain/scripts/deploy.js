const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log("Deployer:", deployer.address);
  console.log("chainId=", network.chainId.toString());

  const Factory = await ethers.getContractFactory("ProofOfRepair");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log("ProofOfRepair deployed:", address);

  const artifact = await artifacts.readArtifact("ProofOfRepair");
  const chainId = Number(network.chainId);
  const cfg = {
    network: chainId === 11155111 ? "sepolia" : "hardhat-local",
    chain_id: chainId,
    rpc_url: chainId === 11155111 ? process.env.SEPOLIA_RPC_URL : "http://127.0.0.1:8545",
    contract_address: address,
    deployer: deployer.address,
    private_key:
      process.env.DEPLOYER_PRIVATE_KEY ||
      // Hardhat node Account #0 (printed at node startup; local only)
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    explorer_tx_prefix: chainId === 11155111 ? "https://sepolia.etherscan.io/tx/" : null,
    explorer_address_prefix: chainId === 11155111 ? "https://sepolia.etherscan.io/address/" : null,
    abi: artifact.abi,
    deployed_at: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, "..", "..", "artifacts", "chain_config.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2));
  console.log("Wrote", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
