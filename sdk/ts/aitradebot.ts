// AITradeBot TypeScript SDK (ethers v6).   npm i ethers
import { ethers, Contract, Wallet, JsonRpcProvider } from "ethers";
import abi from "../abi.json";

export class AITradeBot {
  c: Contract; signer?: Wallet; dec = 18;
  constructor(rpc: string, address: string, privateKey?: string) {
    const provider = new JsonRpcProvider(rpc);
    this.signer = privateKey ? new Wallet(privateKey, provider) : undefined;
    this.c = new Contract(address, abi, this.signer ?? provider);
  }
  static metadataHash(meta: object) { return ethers.sha256(ethers.toUtf8Bytes(JSON.stringify(meta, Object.keys(meta).sort()))); }
  wei(n: number | string) { return ethers.parseUnits(String(n), this.dec); }
  fmt(n: bigint) { return Number(ethers.formatUnits(n, this.dec)); }

  async agent(addr: string) {
    const a = await this.c.agents(addr);
    return { operator: a.operator, bond: this.fmt(a.bond), dailyLimit: this.fmt(a.dailyLimit), slashCount: Number(a.slashCount), anchorCount: Number(a.anchorCount), frozen: a.frozen, registered: a.registered };
  }
  reputation(addr: string): Promise<bigint> { return this.c.reputation(addr); }
  async remainingAllowance(addr: string) { return this.fmt(await this.c.remainingDailyAllowance(addr)); }

  registerAgent(agent: string, meta: object, bond: number, dailyLimit: number) {
    return this.c.registerAgent(agent, AITradeBot.metadataHash(meta), this.wei(bond), this.wei(dailyLimit));
  }
  setDailyLimit(agent: string, limit: number) { return this.c.setDailyLimit(agent, this.wei(limit)); }
  freeze(agent: string) { return this.c.freezeAgent(agent); }
  unfreeze(agent: string) { return this.c.unfreezeAgent(agent); }
  postBounty(amount: number, scope: object) { return this.c.postBounty(this.wei(amount), AITradeBot.metadataHash(scope)); }
  payBounty(id: number, hunter: string) { return this.c.payBounty(id, hunter); }
  pay(to: string, amount: number) { return this.c.transfer(to, this.wei(amount)); }

  /** Proof of performance: anchor a hash of one trade record. */
  static tradeHash(trade: object) { return ethers.sha256(ethers.toUtf8Bytes(JSON.stringify(trade, Object.keys(trade).sort()))); }
  anchorTrade(agent: string, trade: object) { return this.c.anchorTrade(agent, AITradeBot.tradeHash(trade)); }
  payAccess(agent: string, amount: number, plan = "monthly") { return this.c.payAccess(agent, this.wei(amount), ethers.id(plan)); }

  /** Agent-to-agent payment with pre-checks; throws before spending gas. */
  async safePay(to: string, amount: number, minReputation = 0n) {
    const info = await this.agent(to);
    if (!info.registered) throw new Error("counterparty not registered");
    if (info.frozen) throw new Error("counterparty frozen");
    if ((await this.reputation(to)) < minReputation) throw new Error("counterparty reputation too low");
    if (this.signer && (await this.remainingAllowance(this.signer.address)) < amount) throw new Error("exceeds my daily limit");
    return this.pay(to, amount);
  }
}
