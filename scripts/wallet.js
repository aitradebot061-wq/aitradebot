const hre = require("hardhat");
const fs = require("fs"); const path = require("path");
async function main() {
  const [s] = await hre.ethers.getSigners();
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${hre.network.name}.json`), "utf8"));
  const t = await hre.ethers.getContractAt("AITradeBot", dep.token);
  const v = await hre.ethers.getContractAt("TokenVesting", dep.vesting);
  const f = (n) => Number(hre.ethers.formatUnits(n, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 });
  console.log(`wallet ${s.address}`);
  console.log(`  BNB (gas):      ${f(await hre.ethers.provider.getBalance(s.address))}`);
  console.log(`  ATB in wallet:  ${f(await t.balanceOf(s.address))}`);
  console.log(`  ATB vesting for this wallet: ${f((await v.schedulesOf(s.address)).reduce((a, x) => a + x.total, 0n))} (releasable now ${f(await v.releasable(s.address))})`);
}
main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
