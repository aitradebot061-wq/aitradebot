const hre = require("hardhat");
async function main() {
  const [s] = await hre.ethers.getSigners();
  const b = await hre.ethers.provider.getBalance(s.address);
  console.log(`network: ${hre.network.name}\naddress: ${s.address}\nbalance: ${hre.ethers.formatEther(b)} BNB`);
}
main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
