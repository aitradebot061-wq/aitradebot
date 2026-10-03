const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploys AITradeBot + TokenVesting and locks every allocation on-chain.
 * Allocation must match docs/TOKENOMICS.md exactly. The script aborts if the
 * shares below do not sum to 100%, and on mainnet if any beneficiary is unset.
 */
const MONTH = 30 * 24 * 3600;
const SUPPLY = 1_000_000_000n;
const PCT = (p) => (SUPPLY * BigInt(p)) / 100n;

// label, env var for beneficiary, share of supply %, TGE unlock (% of this allocation, sent directly),
// cliff months, total vesting months for the remainder (0 = no vesting, whole allocation sent directly)
const ALLOCATIONS = [
  { label: "Liquidity (PancakeSwap LP)", env: "LIQUIDITY_ADDRESS",  pct: 20, tge: 100, cliff: 0,  duration: 0 },
  { label: "Community & Bounty Pool",    env: "COMMUNITY_ADDRESS",  pct: 35, tge: 0,   cliff: 0,  duration: 36 },
  { label: "Ecosystem & Partners",       env: "ECOSYSTEM_ADDRESS",  pct: 15, tge: 0,   cliff: 6,  duration: 30 },
  { label: "Team",                       env: "TEAM_ADDRESS",       pct: 15, tge: 5,   cliff: 12, duration: 48 },
  { label: "Foundation & Operations",    env: "FOUNDATION_ADDRESS", pct: 15, tge: 0,   cliff: 6,  duration: 30 },
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = hre.network.name;
  const isMainnet = net === "bsc";
  const total = ALLOCATIONS.reduce((s, a) => s + a.pct, 0);
  if (total !== 100) throw new Error(`allocations sum to ${total}%, expected 100%`);

  const addr = (env) => {
    const v = process.env[env];
    if (v && hre.ethers.isAddress(v)) return v;
    if (isMainnet) throw new Error(`${env} must be set to a real (multisig) address for mainnet`);
    console.warn(`  ! ${env} not set — using deployer (testnet only)`);
    return deployer.address;
  };

  const treasury = addr("TREASURY_ADDRESS");
  console.log(`Network: ${net}\nDeployer: ${deployer.address}\nTreasury: ${treasury}`);

  // 1. Token — entire supply minted to deployer, then distributed below
  const Token = await hre.ethers.getContractFactory("AITradeBot");
  const supplyWei = hre.ethers.parseUnits(SUPPLY.toString(), 18);
  const token = await Token.deploy(supplyWei, deployer.address, treasury);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log("AITradeBot:", tokenAddr);

  // 2. Vesting
  const Vest = await hre.ethers.getContractFactory("TokenVesting");
  const vest = await Vest.deploy(tokenAddr, deployer.address);
  await vest.waitForDeployment();
  const vestAddr = await vest.getAddress();
  console.log("TokenVesting:", vestAddr);

  // 3. Distribute
  const start = Math.floor(Date.now() / 1000); // TGE = deployment time
  const WEI = (n) => hre.ethers.parseUnits(n.toString(), 18);
  const split = (a) => {
    const total = PCT(a.pct);
    const now = a.duration === 0 ? total : (total * BigInt(a.tge)) / 100n;
    return { total, now, vested: total - now };
  };
  const vestedTotal = ALLOCATIONS.reduce((s, a) => s + split(a).vested, 0n);
  await (await token.approve(vestAddr, WEI(vestedTotal))).wait();

  const out = { network: net, chainId: hre.network.config.chainId, token: tokenAddr, vesting: vestAddr, treasury, tge: start, allocations: [] };
  for (const a of ALLOCATIONS) {
    const to = addr(a.env);
    const { total, now, vested } = split(a);
    if (now > 0n) await (await token.transfer(to, WEI(now))).wait();
    if (vested > 0n) await (await vest.createSchedule(to, WEI(vested), start, a.cliff * MONTH, a.duration * MONTH, a.label)).wait();
    const desc = a.duration === 0
      ? "direct, lock LP tokens after pool creation"
      : `${a.tge}% at TGE, ${100 - a.tge}% vesting: cliff ${a.cliff}m, linear to ${a.duration}m`;
    console.log(`  ${a.label.padEnd(28)} ${String(a.pct).padStart(2)}%  -> ${to}  (${desc})`);
    out.allocations.push({ ...a, beneficiary: to, amount: total.toString(), unlockedAtTge: now.toString(), vested: vested.toString() });
  }
  const circulating = ALLOCATIONS.reduce((s, a) => s + split(a).now, 0n);
  out.circulatingAtTge = circulating.toString();
  console.log(`Circulating at TGE: ${circulating.toLocaleString("en-US")} ATB (${Number(circulating * 10000n / SUPPLY) / 100}%)`);
  console.log(`Locked in vesting:  ${vestedTotal.toLocaleString("en-US")} ATB`);

  // 4. Freeze vesting admin: no more schedules can ever be created
  await (await vest.renounceOwnership()).wait();
  console.log("Vesting ownership renounced — schedules are final.");

  const left = await token.balanceOf(deployer.address);
  console.log(`Deployer residual balance: ${hre.ethers.formatUnits(left, 18)} ATB (should be 0 unless deployer is a beneficiary)`);

  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", `${net}.json`), JSON.stringify(out, null, 2));

  console.log(`\nVerify:\n  npx hardhat verify --network ${net} ${tokenAddr} ${supplyWei} ${deployer.address} ${treasury}`);
  console.log(`  npx hardhat verify --network ${net} ${vestAddr} ${tokenAddr} ${deployer.address}`);
  console.log(`\nNEXT (manual, multisig):\n  token.setArbiter(<safe>)  token.transferOwnership(<safe>)  then the Safe calls token.acceptOwnership()\n  create PancakeSwap pool, lock LP tokens 12 months, publish lock link`);
}

main().catch((e) => { console.error(e); process.exit(1); });
