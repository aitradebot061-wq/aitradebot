# bot/ — quant bot ↔ ATB contract bridge (Phase 1b)

Everything the live trading stack needs to be a registered, verifiable ATB agent. The trading code itself
lives outside this repo; it imports this package and adds four calls (see `example_live_trader.py`).

| File | Role |
|---|---|
| `atb_bridge.py` | `ATBBridge`: pre-order `guard()` (kill switch + daily cap, cached), post-fill `anchor_fill()` (non-blocking queue with retries), local JSONL anchor log, `status()`. CLI: `status`, `guard`, `anchor-test`, `recent`. |
| `onchain_status.py` | `onchain_tab(bridge)`: JSON for the dashboard "On-chain" tab (reputation, bond, anchors, last 20 hashes with BscScan links). `verify_recent()` re-checks logged tx hashes against chain receipts. |
| `access_indexer.py` | `AccessIndex`: scans `AccessPaid` events into 30-day access grants keyed by payer wallet; `has_access(addr)`. Cursor persisted in `access.<network>.json`. |
| `example_live_trader.py` | Minimal trader loop showing exactly where the four calls go. Runs against testnet. |

## Setup
```bash
pip install -r bot/requirements.txt              # web3.py (v6 or v7)
npx hardhat run scripts/register-agent.js --network bscTestnet
```
`register-agent.js` generates the bot wallet (`BOT_PRIVATE_KEY` appended to `.env`), funds it with gas,
registers it as an agent from the operator wallet (bond `BOT_BOND`, default 10,000 ATB; daily limit
`BOT_DAILY_LIMIT`, default 5,000 ATB) and records the agent in `deployments/<network>.json`.
The bot server needs only `BOT_PRIVATE_KEY` and (optionally) `ATB_NETWORK`, `ATB_RPC`, `ATB_LOGS_RPC`, `ATB_ANCHOR_LOG`.

## Wiring into live_trader.py
```python
from bot.atb_bridge import ATBBridge
atb = ATBBridge.from_env()                         # [1] startup

g = atb.guard(amount_atb=0)                        # [2] before every order
if not g.ok: skip_order(g.reason)                  #     frozen / unregistered / over daily cap / RPC down with no cache

atb.anchor_fill(fill_dict)                         # [3] after every fill (returns immediately)

atb.flush(timeout=60); atb.close()                 # [4] on shutdown: drain the queue
```
`fill_dict` should carry `symbol, side, qty, price, ts, order_id, market`. The anchored hash is
`sha256(json.dumps(fill, sort_keys=True, default=str))`, identical to `AITradeBot.trade_hash` in the SDK, so
anyone holding the fill record can recompute the hash and match it to the `TradeAnchored` event.

## Reference bot
The project's own bot is closed source. It integrates through exactly the four calls above: a guard before every new entry (exits are never blocked), an anchor after every fill from its single fill-logging path, the dashboard data below on an authenticated endpoint, and the access indexer beside its backend. Nothing about its strategy, model or checkpoints is written on-chain or in this repo; only sha256 hashes of fill records are anchored.

## Dashboard
```python
from bot.onchain_status import onchain_tab
@app.get("/api/onchain")
def api_onchain(): return onchain_tab(atb)
```
Fields: `registered, frozen, reputation, bond_atb, daily_limit_atb, remaining_allowance_atb, anchor_count,
slash_count, gas_bnb, explorer_agent, explorer_contract, queue{queued,failed}, recent[{seq, hash, tx, tx_url, block, timestamp, symbol, side, market}]`.

## Access grants (backend)
```bash
python -m bot.access_indexer --loop 60           # keep bot/access.<network>.json current
```
```python
from bot.access_indexer import AccessIndex
idx = AccessIndex.from_env(); idx.sync()
idx.has_access(payer_wallet)                       # 30 days per payment; early renewal extends from current expiry
```
Public bnbchain data-seed RPCs reject `eth_getLogs`; the indexer therefore defaults to publicnode
(`ATB_LOGS_RPC` overrides).

## Operational notes
- The bot wallet holds gas only. The bond sits in the contract and is paid by the operator; slashing burns it.
- `guard()` fails closed when the RPC is down and nothing is cached, and serves the last cached state (marked `stale`) otherwise.
- Anchors are sent sequentially from one worker thread, so nonces never collide. Failed fills end up in
  `bridge.pending_failures` and the `on_error` callback; permanent errors (`agent frozen`, `not registered`) are not retried.
- Kill switch: `freezeAgent(bot)` from the operator (or owner) makes `guard()` return `agent frozen (kill switch)` within `guard_ttl` seconds (default 10) and makes `anchorTrade` revert.
- Gas: one anchor costs about 37k gas (71k for the first). At 0.02 tBNB the wallet covers thousands of testnet anchors; top up when `status()["gas_bnb"]` drops below 0.005.
