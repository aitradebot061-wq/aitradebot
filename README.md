# AI Trade Bot (ATB) — BNB Chain

Verification and safety layer for AI trading agents, shipped as a BEP-20 token contract plus an open-source quant trading stack.
Bots anchor every filled trade on-chain, run under a daily spend cap and a kill switch, and post a slashable ATB bond. Users keep custody: bots run on the user's own exchange account.

- Whitepaper: [docs/WHITEPAPER.md](docs/WHITEPAPER.md)
- Tokenomics (mirrored 1:1 in code): [docs/TOKENOMICS.md](docs/TOKENOMICS.md)
- Pricing: [docs/PRICING.md](docs/PRICING.md)
- Launch checklist: [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md)
- CMC application draft: [docs/CMC-APPLICATION.md](docs/CMC-APPLICATION.md)
- Korean versions: `docs/ko/`

## Contracts
| File | Purpose |
|---|---|
| `contracts/AITradeBot.sol` | ATB token: agent registry, daily cap, kill switch, slashing, trade anchoring, access fees, bounties. Fixed supply, no mint. |
| `contracts/TokenVesting.sol` | Irrevocable linear vesting with cliff; several schedules per beneficiary; no revoke/withdraw. |

## Deploy
1. `npm install`
2. `cp .env.example .env` — set `PRIVATE_KEY` (fresh deploy-only wallet) and `ETHERSCAN_API_KEY`. Mainnet also requires all 6 beneficiary addresses (multisigs; team wallet separate from the deployer).
3. Testnet gas: https://www.bnbchain.org/en/testnet-faucet
4. `npm run compile` → `npm test` → `npm run deploy:testnet`
   The script deploys token + vesting, locks every allocation, renounces the vesting owner, and writes `deployments/<network>.json`.
5. Run the two `hardhat verify` commands printed by the script.
6. Exercise `registerAgent` / `anchorTrade` / `payAccess` / `freezeAgent` / `slash` / bounties on testnet.
7. Audit, then `npm run deploy:mainnet`, then `setArbiter` + `transferOwnership` to the Safe.

## SDK
`sdk/python/aitradebot.py` (web3.py) and `sdk/ts/aitradebot.ts` (ethers v6) with `sdk/abi.json` / `sdk/vesting.abi.json`.
Key calls: `register_agent`, `anchor_trade`, `pay_access`, `freeze`, `safe_pay`.

## Bot integration (`bot/`)
Bridge between the quant trading stack and the contract — `guard()` before each order (kill switch + daily cap), `anchor_fill()` after each fill, dashboard "On-chain" tab data, and an `AccessPaid` → 30-day access-grant indexer. See [bot/README.md](bot/README.md).
```bash
npx hardhat run scripts/register-agent.js --network bscTestnet   # bot wallet + bond + registration
python bot/atb_bridge.py status                                  # agent state from the bot wallet
python -m bot.access_indexer                                     # index access payments
```
Testnet reference agent: `0x6F90de57291A757f903d70f3cACcf4e23943026F`.

## Site
`site/index.html` — static, English default with Korean toggle, reads live counters from the contract over JSON-RPC once `ATB.token` is set.

## Security notes
- Unaudited until the report is published. Do not deploy to mainnet before an external audit.
- Move `owner` and `arbiter` to a Safe multisig immediately after deployment.
- Publish slashing criteria; every slash carries its reason on-chain.
- Commit `deployments/<network>.json` so all allocation wallets are public.
