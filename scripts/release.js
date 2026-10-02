const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Claim vested tokens for a beneficiary.
 *   npx hardhat run scripts/release.js --network bsc                 # beneficiary = signer
 *   BENEFICIARY=0x... npx hardhat run scripts/release.js --network bsc
 * Anyone may call release(); tokens always go to the beneficiary, never to the caller.
 */
async function main() {
  const net = hre.network.name;
  const file = path.join(__dirname, "..", "deployments", `${net}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment found for ${net} (${file})`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));

  const [signer] = await hre.ethers.getSigners();
  const beneficiary = process.env.BENEFICIARY || signer.address;
  const vest = await hre.ethers.getContractAt("TokenVesting", dep.vesting, signer);
  const token = await hre.ethers.getContractAt("AITradeBot", dep.token, signer);
  const f = (n) => Number(hre.ethers.formatUnits(n, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 });

  const schedules = await vest.schedulesOf(beneficiary);
  if (schedules.length === 0) { console.log(`No vesting schedules for ${beneficiary}`); return; }

  const now = Math.floor(Date.now() / 1000);
  console.log(`Beneficiary: ${beneficiary}\n`);
  for (const s of schedules) {
    const cliffAt = Number(s.start) + Number(s.cliff);
    const endAt = Number(s.start) + Number(s.duration);
    const status = now < cliffAt ? `cliff ends ${new Date(cliffAt * 1000).toISOString().slice(0, 10)}`
                 : now >= endAt ? "fully vested" : `vesting until ${new Date(endAt * 1000).toISOString().slice(0, 10)}`;
    console.log(`  ${s.label.padEnd(26)} total ${f(s.total).padStart(14)} ATB  released ${f(s.released).padStart(14)} ATB  (${status})`);
  }

  const due = await vest.releasable(beneficiary);
  console.log(`\nReleasable now: ${f(due)} ATB`);
  if (due === 0n) return;

  const tx = await vest.release(beneficiary);
  console.log(`release() sent: ${tx.hash}`);
  await tx.wait();
  console.log(`Done. Balance of ${beneficiary}: ${f(await token.balanceOf(beneficiary))} ATB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
