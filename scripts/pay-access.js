// Pay an access fee to an agent (demo/testnet):  AMOUNT=100 PLAN=standard npx hardhat run scripts/pay-access.js --network bscTestnet
const hre = require("hardhat"); const fs = require("fs"); const path = require("path");
async function main() {
  const [s] = await hre.ethers.getSigners();
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8"));
  const t = await hre.ethers.getContractAt("AITradeBot", dep.token);
  const agent = process.env.AGENT || dep.agent?.address; if (!agent) throw new Error("no agent (set AGENT or run register-agent.js)");
  const amount = hre.ethers.parseUnits(process.env.AMOUNT || "100", 18);
  const plan = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(process.env.PLAN || "standard"));
  const tx = await t.payAccess(agent, amount, plan); const rc = await tx.wait();
  console.log(`payAccess ${process.env.AMOUNT || "100"} ATB plan=${process.env.PLAN || "standard"} from ${s.address} -> agent ${agent}  ${tx.hash} (block ${rc.blockNumber})`);
}
main().catch((e) => { console.error("ERR:", e.reason || e.message); process.exit(1); });
