# AI Trade Bot Pricing v1.0

> Decided 2026-10-01. ATB is the means of payment. Prices are fixed in USD and converted to ATB at the rate quoted at checkout. Users run bots on their own exchange accounts with their own API keys. We never hold or manage funds.

## Tiers

| Tier | Monthly (USD) | Includes | On-chain plan id |
|---|---|---|---|
| **Free** | $0 | Dashboard, bot leaderboard, backtests and crash/pump benchmarks, read every bot's on-chain track record | — |
| **Standard** | $29 | Run 1 crypto bot (Binance), Telegram and web-push alerts, stop-loss and wallet guard | `keccak256("standard-monthly")` |
| **Pro** | $99 | Unlimited crypto bots, every strategy, priority support, early access to new strategies | `keccak256("pro-monthly")` |

- Annual billing: pay 10 months, get 12.
- Fee split: every payment is 50% burned, 50% to the treasury (the contract never burns less than 30%). A $99 Pro month burns $49.50 of ATB.
- Bot operators (people who register and publish their own bot) additionally lock a minimum 1,000 ATB bond and pay a 100 ATB registration fee, independent of the plan.

## Payment flow

1. User picks a tier in the dashboard → backend quotes the ATB amount at the current ATB/USD rate (quote valid 10 minutes).
2. User sends `payAccess(agent, amount, planId)`. 50% is burned, 50% goes to the treasury.
3. Backend confirms the `AccessPaid(payer, agent, amount, plan)` event and grants the payer wallet 30 days of access.
4. Dashboard login is a wallet signature (SIWE-style) that proves control of the payer address.

## Price source

- Primary: PancakeSwap ATB/WBNB pool 30-minute TWAP × Chainlink BNB/USD.
- Testnet, before a pool exists: fixed rate 1 ATB = $0.01, labelled as a test rate in the docs and UI.

## Regulatory notes

- This is a software subscription. No return promise, no principal guarantee, no revenue share.
- Prices may change at any time; changes apply from the next billing cycle.
