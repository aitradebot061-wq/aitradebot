# AI Trade Bot (ATB) Tokenomics v1.0

> Every number in this document is mirrored in `scripts/deploy.js` (`ALLOCATIONS`) and in the constants of `contracts/AITradeBot.sol`. If the document and the code ever disagree, the code is the truth and the document is wrong.

## 1. Principles

1. **Fixed supply.** 1,000,000,000 ATB. There is no mint function, so nobody can ever create more.
2. **Deflationary.** Slashed bonds are burned 100%. At least 30% of every protocol fee is burned by code.
3. **No public sale.** No presale, ICO or IDO. ATB enters circulation only through the DEX pool, bounty rewards, community programs and partner grants.
4. **Every lock-up is on-chain.** Team, foundation and partner allocations are deposited in full into an irrevocable vesting contract inside the deployment transaction. This is not a promise to lock later; it executes in the same transaction that creates the token.
5. **Bounded admin.** The owner can change fee rates (within hard caps) and the minimum bond. Nothing else. There is no blacklist, no per-address tax and no transfer restriction.

## 2. Allocation

| Allocation | Share | Amount (ATB) | Cliff | Vesting | Recipient |
|---|---|---|---|---|---|
| Liquidity (PancakeSwap LP) | 20% | 200,000,000 | — | Immediate; LP tokens locked 12 months via third-party locker | Foundation multisig |
| Community & bounty pool | 35% | 350,000,000 | — | 36-month linear | Foundation multisig |
| Ecosystem & partners | 15% | 150,000,000 | 6 months | 30-month linear | Foundation multisig |
| Team | 15% | 150,000,000 | 12 months | 5% (7,500,000) unlocked at TGE; remaining 142,500,000 vest 48-month linear after the cliff | Team wallet (hardware or multisig) |
| Foundation & operations | 15% | 150,000,000 | 6 months | 30-month linear | Foundation multisig |
| **Public sale** | **0%** | 0 | | | |

- Vesting is measured from TGE (the deployment timestamp). Nothing vests before the cliff; at the cliff the linearly accrued amount unlocks at once, then vesting continues per second.
- The vesting contract's owner key is renounced in the deployment script, so no schedule can be created or changed afterwards.
- Liquidity tokens are used to seed the pool; LP tokens are locked for 12 months and the lock link is published.
- The team's TGE unlock is 0.75% of total supply, disclosed here and in `deployments/bsc.json`. Any team sale is announced 48 hours ahead.
- There is no separate "early contributors" bucket. Future contributors are paid as grants from the community pool by the foundation multisig, so the founder's share is exactly what the table says.

### Circulating supply schedule (indicative)

| Time | Unlockable | Share |
|---|---|---|
| TGE | 207,500,000 (liquidity + team 5%) | 20.75% |
| 6 months | ~325,800,000 | 32.6% |
| 12 months | ~479,800,000 | 48.0% |
| 24 months | ~752,100,000 | 75.2% |
| 36 months | ~964,400,000 | 96.4% |
| 48 months | 1,000,000,000 | 100% |

Community-pool tokens stay in the foundation wallet after vesting until actually distributed, so true circulating supply runs below this table.

## 3. Demand and burn flows

| Flow | Who pays | How much | Burned | Treasury |
|---|---|---|---|---|
| Bot access (`payAccess`) | Bot users | Per plan, USD-priced (see PRICING.md) | 50% | 50% |
| Bot registration fee | Bot operators | 100 ATB (cap 1,000) | 50% | 50% |
| Bounty fee | Taken from bounty payouts | 2% (cap 5%) | 50% | 50% |
| Slashing | Misbehaving bot's bond | Arbiter decision | 100% | 0% |
| Operator bond | Bot operators | Minimum 1,000 ATB | Locked while live | |

**Hard caps (contract constants):**

| Constant | Value | Meaning |
|---|---|---|
| `MIN_FEE_BURN_BPS` | 3,000 | Burn share floor of 30%; owner can only raise it |
| `MAX_BOUNTY_FEE_BPS` | 500 | Bounty fee can never exceed 5% |
| `MAX_REGISTRATION_FEE` | 1,000 ATB | Registration fee ceiling |
| `MAX_MIN_BOND` | 100,000 ATB | Minimum-bond ceiling |
| `MAX_PAUSE` | 7 days | A pause expires on its own |
| `PAUSE_COOLDOWN` | 7 days | Minimum unpaused time before another pause |
| `UNBOND_DELAY` | 7 days | Dispute window before a bond is returned |

**Transparency counters (public view functions):** `totalBurned`, `totalTreasuryFees`, `totalAccessPaid`, `agentCount`, `totalAnchors`. The website dashboard reads them directly.

## 4. Treasury spending policy

Treasury fee income is spent in this published order of priority:

1. External audits and additional bug-bounty funding
2. Infrastructure (RPC, indexer, dashboard hosting)
3. Liquidity reinforcement
4. Engineering

The treasury is a Safe multisig (3/5). Quarterly spending reports are published.

## 5. Powers and their transfer plan

| Role | Now | Target | Can | Cannot |
|---|---|---|---|---|
| `owner` | Deployer → Safe 3/5 at launch | DAO, 2027 Q2 | Fee rates within caps, min bond within cap, arbiter/treasury addresses, bounded pause, emergency freeze of a registered agent | Mint, blacklist, alter vesting, seize bonds, change an agent's daily limit, unfreeze an agent, touch unregistered wallets |
| `arbiter` | Deployer → Safe 3/5 at launch | Dispute DAO, 2027 Q2 | Slash registered bots' bonds (reason on-chain) | Touch any non-bond balance |
| Vesting `owner` | Renounced at deployment | — | Nothing | Everything |

Pause exists for incident response before the audit. It lasts at most 7 days, cannot be re-armed for 7 days after it ends, and `disablePauseForever()` removes it for good. The Safe will call it once the audit report is public. Ownership moves in two steps: the new owner must call `acceptOwnership()`.

## 6. Regulatory positioning

- ATB is a **utility token** used for bot access, operator bonds and bounty payouts.
- There is **no dividend, no revenue share, no buyback promise and no principal guarantee.** The contract has no such function and none will be added.
- No user funds are pooled or managed. Bots run on the user's own exchange account with the user's own API keys.
- With no public sale, ATB is not offered under any jurisdiction's public-offering rules, but participants remain responsible for local tax and virtual-asset regulation. Korean residents should check the Virtual Asset User Protection Act and the crypto taxation schedule under the Income Tax Act.

## 7. Verify it yourself

```
token.totalSupply()          == 1,000,000,000 * 1e18   // and no mint() exists
vesting.totalLocked()        == 792,500,000 * 1e18     // at TGE
vesting.owner()              == 0x0                    // renounced
token.MIN_FEE_BURN_BPS()     == 3000
token.MAX_BOUNTY_FEE_BPS()   == 500
token.MAX_REGISTRATION_FEE() == 1000 * 1e18
```

`deployments/<network>.json` records every recipient address and schedule and is committed to the repository.
