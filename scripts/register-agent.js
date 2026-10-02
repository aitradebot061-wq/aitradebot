/**
 * Register the quant bot wallet as an ATB agent (Phase 1b).
 *
 *   npx hardhat run scripts/register-agent.js --network bscTestnet
 *
 * - Bot wallet: BOT_PRIVATE_KEY in .env. If missing, a fresh key is generated and appended to .env.
 *   The bot wallet holds only gas; the bond is paid by the operator (deployer/treasury signer).
 * - Sends BOT_GAS_BNB (default 0.02) to the bot wallet if it has less than that.
 * - Calls registerAgent(bot, metadataHash, BOND, DAILY_LIMIT) from the operator.
 * - Writes the agent address + metadata into deployments/<network>.json.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BOND = process.env.BOT_BOND || "10000";          // ATB, >= minBond (1,000)
const DAILY_LIMIT = process.env.BOT_DAILY_LIMIT || "5000"; // ATB per 24h the bot wallet may transfer
const GAS_BNB = process.env.BOT_GAS_BNB || "0.02";

const META = {
  // Only sha256(META) goes on-chain. Keep this generic: the strategy, model and checkpoints are private.
  name: "ATB reference quant agent",
  version: "1.0.0",
  markets: ["binance-spot", "binance-futures"],
  risk: "stop-loss watcher, wallet guard, session risk controls; on-chain daily cap + kill switch via ATB",
  custody: "user exchange account, trade-only API keys",
};

async function main() {
  const [op] = await hre.ethers.getSigners();
  const net = hre.network.name;
  const depPath = path.join(__dirname, "..", "deployments", `${net}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const token = await hre.ethers.getContractAt("AITradeBot", dep.token);
  const fmt = (n) => Number(hre.ethers.formatUnits(n, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 });

  // 1. bot wallet
  let botKey = process.env.BOT_PRIVATE_KEY;
  if (!botKey) {
    botKey = "0x" + crypto.randomBytes(32).toString("hex");
    const envPath = path.join(__dirname, "..", ".env");
    fs.appendFileSync(envPath, `\n# --- quant bot agent wallet (holds gas only; bond is paid by the operator) ---\nBOT_PRIVATE_KEY=${botKey}\n`);
    console.log("generated new bot wallet, BOT_PRIVATE_KEY appended to .env");
  }
  const bot = new hre.ethers.Wallet(botKey, hre.ethers.provider);
  console.log(`operator ${op.address}\nbot      ${bot.address}`);

  // 2. gas for the bot
  const gasWei = hre.ethers.parseEther(GAS_BNB);
  const botBal = await hre.ethers.provider.getBalance(bot.address);
  if (botBal < gasWei) {
    const tx = await op.sendTransaction({ to: bot.address, value: gasWei - botBal });
    await tx.wait();
    console.log(`sent ${hre.ethers.formatEther(gasWei - botBal)} BNB gas to bot  ${tx.hash}`);
  }

  // 3. register
  const a = await token.agents(bot.address);
  const metadataHash = "0x" + crypto.createHash("sha256").update(JSON.stringify(META, Object.keys(META).sort())).digest("hex");
  if (a.registered) {
    console.log("already registered; skipping registerAgent");
  } else {
    const bond = hre.ethers.parseUnits(BOND, 18);
    const limit = hre.ethers.parseUnits(DAILY_LIMIT, 18);
    const fee = await token.registrationFee();
    const bal = await token.balanceOf(op.address);
    if (bal < bond + fee) throw new Error(`operator holds ${fmt(bal)} ATB, needs ${fmt(bond + fee)} (bond + fee)`);
    const tx = await token.registerAgent(bot.address, metadataHash, bond, limit);
    const rc = await tx.wait();
    console.log(`registerAgent  bond ${BOND} ATB  dailyLimit ${DAILY_LIMIT} ATB  fee ${fmt(fee)} ATB  ${tx.hash}  (block ${rc.blockNumber})`);
  }

  // 4. record
  const info = await token.agents(bot.address);
  dep.agent = {
    address: bot.address,
    operator: info.operator,
    bond: hre.ethers.formatUnits(info.bond, 18),
    dailyLimit: hre.ethers.formatUnits(info.dailyLimit, 18),
    metadataHash,
    metadata: META,
    registeredAt: Number(info.registeredAt),
  };
  fs.writeFileSync(depPath, JSON.stringify(dep, null, 2) + "\n");
  const explorer = net === "bsc" ? "https://bscscan.com" : "https://testnet.bscscan.com";
  console.log(`\nagent registered  reputation ${await token.reputation(bot.address)}  frozen ${info.frozen}`);
  console.log(`bot gas balance   ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(bot.address))} BNB`);
  console.log(`${explorer}/address/${bot.address}`);
  console.log(`written to deployments/${net}.json (agent)`);
}
main().catch((e) => { console.error("ERR:", e.reason || e.message); process.exit(1); });
