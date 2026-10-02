# CoinMarketCap Listing Application — Draft

> Replace every `[ ]` with real values before submitting. CMC wants verifiable links and concrete numbers; hype language costs points. Submit the CoinGecko form the same day with the same data.

**Project name:** AI Trade Bot
**Ticker:** ATB
**Blockchain:** BNB Smart Chain (BEP-20)
**Contract address:** [ after mainnet deployment ]
**Decimals:** 18
**Total supply:** 1,000,000,000
**Max supply:** 1,000,000,000 (no mint function)
**Circulating supply:** [ number + link to docs/TOKENOMICS.md §2 and deployments/bsc.json ]
**Launch date:** [ YYYY-MM-DD ]

**Website:** [ https://aitradebot.xyz ]
**Whitepaper:** [ https://aitradebot.xyz/docs/WHITEPAPER.md ]
**Explorer:** https://bscscan.com/token/[address]
**Source code:** [ GitHub URL ] (BscScan verified)
**Audit:** [ report link ]

**Social:** X [ ], Telegram [ ], Discord [ ]

**Exchange / trading pair:** PancakeSwap v3, ATB/WBNB — [ pool address ]
**Liquidity locked:** [ locker link, 12 months ]

**Project description (short, ≤ 300 chars):**
AI Trade Bot (ATB) is a BNB Chain utility token that verifies AI trading agents. Bots anchor every filled trade on-chain, run under a daily spend cap and an operator kill switch, and post a slashable ATB bond. Users run bots on their own exchange accounts; ATB never holds funds.

**Detailed description:**
AI trading bots show screenshots; ATB bots write hashes to the chain. An operator registers a bot wallet with a metadata hash and a minimum 1,000 ATB bond. From then on, every filled order is anchored via `anchorTrade`, transfers from the bot wallet are capped per 24 hours, and the operator or owner can freeze it instantly. An arbiter can slash a misbehaving bot's bond; slashed tokens are burned with the reason recorded on-chain. Anyone can read a bot's reputation (bond + days live + anchors − slashes) before trusting it.

ATB is used for three things: paying for bot access (USD-priced plans, paid in ATB, 50% burned), operator bonds, and security bounties. Supply is fixed at 1B with no mint function; at least 30% of every protocol fee is burned by contract constant. There was no public sale. Team, foundation and partner allocations (80% of supply) sit in an irrevocable vesting contract deployed and funded in the same transaction as the token, with the vesting admin key renounced.

The first registered agent is the project's own quant stack (Binance) with [ N ] anchored live trades as of [ date ]. [ Add real usage: registered bots, anchored trades, slashes, bounties paid — pulled from the on-chain counters. ]

**Team:** [ real names or public profiles — anonymous teams lose credibility ]

**Proof of authenticity:** Post the CMC application on the official X account and attach the link.

## Pre-submission checklist
- [ ] Mainnet deployment + BscScan verification (token and vesting contracts)
- [ ] `deployments/bsc.json` committed and linked
- [ ] PancakeSwap pool created, LP locked, lock link public
- [ ] At least 10 organic trades in the first 30 days (bot trades hurt)
- [ ] BscScan token info updated (logo, website, socials)
- [ ] Website live, whitepaper and tokenomics reachable
- [ ] DEX Screener / DexTools page claimed
- [ ] Audit report published
- [ ] Reference agent anchoring live trades; counters non-zero
