# AI Trade Bot (ATB) — Whitepaper v1.0

*BNB Smart Chain · BEP-20 · October 2026*

## 1. The problem

AI trading bots are everywhere. Proof is nowhere.

- **Performance is unverifiable.** Every bot vendor shows screenshots and backtests. Both are trivially edited. Nobody can check whether the trades happened.
- **Users hand over custody.** The typical "AI trading" product asks you to deposit funds. That is where fraud lives, and where regulators focus.
- **Bots have no blast radius.** A hijacked or misconfigured bot with API access can drain an account in minutes. There is no on-chain cap, no kill switch, no accountability.

## 2. The solution

AI Trade Bot is a **verification and safety layer for AI trading agents**, delivered as a BEP-20 token contract on BNB Chain plus an open-source trading stack.

| Feature | What it does | Why it matters |
|---|---|---|
| Agent registry | An operator registers a bot wallet with a metadata hash and an ATB bond | Identity and skin in the game |
| Trade anchoring | The bot writes a hash of every filled order to the chain | A track record that cannot be photoshopped |
| Daily spend cap | Transfers from a registered bot wallet are capped per 24 hours | Bounded loss if the bot is compromised |
| Kill switch | Operator or owner freezes a bot instantly; only the operator can unfreeze | Immediate containment |
| Slashing | An arbiter cuts a misbehaving bot's bond; slashed tokens are burned, reason recorded on-chain | Enforced accountability |
| On-chain reputation | bond + days live + anchors/10 − 100 per slash, readable by anyone | Pick a bot by evidence, not marketing |
| Bounty escrow | Vulnerability rewards locked in ATB, paid after verification | Incentive for security research |

**The bot runs on the user's own exchange account.** Bots trade crypto on Binance. API keys are trade-only; withdrawal permission stays off. AI Trade Bot never takes custody of user funds.

## 3. The reference agent

The first registered agent is the project's own quantitative trading stack, already running live:

- Crypto engine (Binance spot/futures) with a web dashboard, PWA and push alerts
- Proprietary AI strategies, validated walk-forward on data they were never trained on
- Stop-loss watcher, wallet guard and session-level risk controls
- Crash/pump benchmark harness for stress-testing strategies

Every live fill from this stack is anchored through `anchorTrade`, giving the network its first verifiable track record before any third-party bot joins.

## 4. Token utility

ATB is a utility token with three uses. It carries no profit share, no dividend, no buyback promise and no claim on revenue.

1. **Access.** Bot subscriptions are priced in USD and paid in ATB via `payAccess`. 50% of every payment is burned, 50% goes to the treasury.
2. **Bond.** Operators lock at least 1,000 ATB to register a bot and pay a 100 ATB registration fee. Bonds are slashable.
3. **Bounties.** Security bounties are escrowed and paid in ATB; a 2% protocol fee applies to payouts.

## 5. Tokenomics

Full specification: [TOKENOMICS.md](TOKENOMICS.md). Every number is mirrored in `scripts/deploy.js` and in contract constants.

- Total supply 1,000,000,000 ATB. No mint function exists.
- **No public sale.** No presale, ICO or IDO.
- Slashing burns 100%. At least 30% of every protocol fee is burned (enforced by `MIN_FEE_BURN_BPS`).
- All team, foundation and partner allocations are deposited into an irrevocable vesting contract inside the deployment transaction, after which the vesting admin key is renounced. The only team tokens liquid at launch are 5% of the team allocation (0.75% of supply).

| Allocation | Share | Cliff | Vesting |
|---|---|---|---|
| Liquidity (PancakeSwap) | 20% | — | LP tokens locked 12 months |
| Community & bounty pool | 35% | — | 36-month linear |
| Ecosystem & partners | 15% | 6 months | 30-month linear |
| Team | 15% | 12 months | 5% at TGE, 95% 48-month linear |
| Foundation & operations | 15% | 6 months | 30-month linear |
| Public sale | 0% | | |

## 6. Roadmap

- **2026 Q4** — BSC testnet → external audit → BNB mainnet. PancakeSwap pool with 12-month LP lock. CoinMarketCap and CoinGecko listing. Reference agent starts anchoring live trades.
- **2027 Q1** — Bot SDK (Python / TypeScript): `register`, `anchorTrade`, `payAccess`, `freeze`. Public bot leaderboard.
- **2027 Q2** — Arbiter multisig → dispute DAO. Pause key renounced after audit.
- **2027 Q3** — Third-party bots onboard with bonds. Verification API for other platforms.

## 7. Governance and security

- `owner` and `arbiter` move to a Safe multisig (3/5) immediately after deployment.
- Owner powers are limited to fee parameters within hard caps, minimum bond, address updates and pause. There is no mint, no blacklist, no transfer restriction and no way to alter vesting.
- Slashing criteria are published; every slash carries its reason as an on-chain event.
- The audit report is published on the website before mainnet.

## 8. Legal notice

ATB is a utility token, not an investment product, security or deposit. AI Trade Bot does not pool, hold or manage user funds and makes no promise of return. Trading involves risk of loss. Participants are responsible for compliance with the laws of their jurisdiction, including the Republic of Korea's Virtual Asset User Protection Act.
