const hre = require("hardhat");
const fs = require("fs"); const path = require("path");
async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8"));
  const t = await hre.ethers.getContractAt("AITradeBot", dep.token);
  const v = await hre.ethers.getContractAt("TokenVesting", dep.vesting);
  const f = (n) => hre.ethers.formatUnits(n, 18);
  console.log(`${await t.name()} (${await t.symbol()})  supply ${f(await t.totalSupply())}`);
  console.log(`owner ${await t.owner()}  arbiter ${await t.arbiter()}  treasury ${await t.treasury()}`);
  console.log(`fees: burn ${await t.feeBurnBps()} bps (min ${await t.MIN_FEE_BURN_BPS()}), bounty ${await t.bountyFeeBps()} bps (max ${await t.MAX_BOUNTY_FEE_BPS()}), registration ${f(await t.registrationFee())} ATB, minBond ${f(await t.minBond())} ATB`);
  console.log(`counters: agents ${await t.agentCount()}, anchors ${await t.totalAnchors()}, burned ${f(await t.totalBurned())}, accessPaid ${f(await t.totalAccessPaid())}`);
  console.log(`vesting: locked ${f(await v.totalLocked())} ATB in ${await v.scheduleCount()} schedules, owner ${await v.owner()}`);
}
main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
