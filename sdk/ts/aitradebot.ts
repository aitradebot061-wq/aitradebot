// AITradeBot TypeScript SDK (ethers v6).   npm i ethers
import { ethers, Contract, Wallet, JsonRpcProvider } from "ethers";
import abi from "../abi.json";

/**
 * Canonical JSON shared with the Python SDK (json.dumps(obj, sort_keys=True)):
 * keys sorted at every level, separators ", " and ": ", non-ASCII escaped as \uXXXX.
 * Use integers or strings for numbers that must hash identically across languages
 * (Python writes 1.0 where JavaScript writes 1).
 */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") {
    return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  }
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(", ") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => canonicalJson(k) + ": " + canonicalJson(o[k])).join(", ") + "}";
  }
  return canonicalJson(String(v));
}

export class AITradeBot {
  c: Contract; signer?: Wallet; dec = 18;
  constructor(rpc: string, address: string, privateKey?: string) {
    const provider = new JsonRpcProvider(rpc);
    this.signer = privateKey ? new Wallet(privateKey, provider) : undefined;
    this.c = new Contract(address, abi, this.signer ?? provider);
  }
  static metadataHash(meta: object) { return ethers.sha256(ethers.toUtf8Bytes(canonicalJson(meta))); }
  wei(n: number | string) { return ethers.parseUnits(String(n), this.dec); }
  fmt(n: bigint) { return Number(ethers.formatUnits(n, this.dec)); }

  async agent(addr: string) {
    const a = await this.c.agents(addr);
    return {
      operator: a.operator, bond: this.fmt(a.bond), dailyLimit: this.fmt(a.dailyLimit),
      slashCount: Number(a.slashCount), anchorCount: Number(a.anchorCount),
      unbonding: a.unbondRequestedAt > 0n, frozen: a.frozen, registered: a.registered,
    };
  }
  reputation(addr: string): Promise<bigint> { return this.c.reputation(addr); }
  async remainingAllowance(addr: string) { return this.fmt(await this.c.remainingDailyAllowance(addr)); }
  anchorHead(addr: string): Promise<string> { return this.c.anchorHead(addr); }

  /** Recompute the on-chain anchor hash chain from an ordered list of trade hashes. */
  static chainHead(tradeHashes: string[], start: string = ethers.ZeroHash) {
    return tradeHashes.reduce((head, h) => ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [head, h]), start);
  }

  /** Sent BY the agent wallet: consent to be registered by `operator`. Required before registerAgent. */
  approveOperator(operator: string) { return this.c.approveOperator(operator); }

  /** Operator call. The agent wallet must have called approveOperator(operator) first, or be the operator. */
  registerAgent(agent: string, meta: object, bond: number, dailyLimit: number) {
    return this.c.registerAgent(agent, AITradeBot.metadataHash(meta), this.wei(bond), this.wei(dailyLimit));
  }
  setDailyLimit(agent: string, limit: number) { return this.c.setDailyLimit(agent, this.wei(limit)); }
  freeze(agent: string) { return this.c.freezeAgent(agent); }
  unfreeze(agent: string) { return this.c.unfreezeAgent(agent); }
  requestUnbond(agent: string) { return this.c.requestUnbond(agent); }
  cancelUnbond(agent: string) { return this.c.cancelUnbond(agent); }
  deregister(agent: string) { return this.c.deregisterAgent(agent); }
  postBounty(amount: number, scope: object) { return this.c.postBounty(this.wei(amount), AITradeBot.metadataHash(scope)); }
  payBounty(id: number, hunter: string) { return this.c.payBounty(id, hunter); }
  pay(to: string, amount: number) { return this.c.transfer(to, this.wei(amount)); }

  /** Proof of performance: anchor a hash of one trade record (same hash as the Python SDK). */
  static tradeHash(trade: object) { return ethers.sha256(ethers.toUtf8Bytes(canonicalJson(trade))); }
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
