// Kill switch from the operator/owner wallet:  ACTION=freeze|unfreeze npx hardhat run scripts/freeze-agent.js --network bscTestnet
const hre = require("hardhat"); const fs = require("fs"); const path = require("path");
async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8"));
  const t = await hre.ethers.getContractAt("AITradeBot", dep.token);
  const agent = process.env.AGENT || dep.agent?.address; if (!agent) throw new Error("no agent");
  const action = process.env.ACTION || "freeze";
  const tx = action === "unfreeze" ? await t.unfreezeAgent(agent) : await t.freezeAgent(agent);
  await tx.wait();
  console.log(`${action} ${agent}  frozen=${(await t.agents(agent)).frozen}  ${tx.hash}`);
}
main().catch((e) => { console.error("ERR:", e.reason || e.message); process.exit(1); });
