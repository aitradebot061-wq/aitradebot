"""Reference wiring of the ATB bridge into a live trader loop.

Copy the three marked blocks into the real live_trader.py. Nothing else in the trading stack changes:
the bridge never touches exchange keys or user funds; it only reads agent state and writes trade hashes.

Run this file to see the flow against BSC testnet (sends real anchor txs from the bot wallet):
    python -m bot.example_live_trader
"""
from __future__ import annotations

import logging
import time

from bot.atb_bridge import ATBBridge

log = logging.getLogger("live_trader")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


class LiveTrader:
    def __init__(self) -> None:
        # --- [1] startup: one bridge per process; the anchor worker thread starts lazily ---
        self.atb = ATBBridge.from_env(
            on_anchor=lambda r: log.info("anchored #%s %s", r.seq, r.explorer_tx),
            on_error=lambda t, e: log.error("anchor failed for %s: %s", t.get("order_id"), e),
        )
        st = self.atb.status()
        log.info("ATB agent %s registered=%s frozen=%s reputation=%s", st["agent"], st["registered"], st["frozen"], st["reputation"])

    def place_order(self, symbol: str, side: str, qty: float, market: str) -> dict | None:
        # --- [2] pre-order guard: honour the on-chain kill switch and daily cap ---
        # amount_atb only matters if the bot wallet itself transfers ATB; exchange orders pass 0.
        g = self.atb.guard(amount_atb=0)
        if not g.ok:
            log.warning("order %s %s %s skipped: %s", side, qty, symbol, g.reason)
            return None

        fill = self._send_to_exchange(symbol, side, qty, market)  # existing exchange call

        # --- [3] post-fill anchor: non-blocking, keyed by the exchange order id ---
        if fill:
            self.atb.anchor_fill({
                "symbol": fill["symbol"],
                "side": fill["side"],
                "qty": fill["qty"],
                "price": fill["price"],
                "ts": fill["ts"],
                "order_id": fill["order_id"],
                "market": market,
            })
        return fill

    def _send_to_exchange(self, symbol: str, side: str, qty: float, market: str) -> dict:
        # placeholder for the real exchange call
        return {"symbol": symbol, "side": side, "qty": qty, "price": 0, "market": market,
                "order_id": f"demo-{int(time.time() * 1000)}", "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    def shutdown(self) -> None:
        # --- [4] shutdown: drain the anchor queue so no fill is left unanchored ---
        self.atb.flush(timeout=60)
        self.atb.close()


if __name__ == "__main__":
    t = LiveTrader()
    t.place_order("BTCUSDT", "BUY", 0.001, "binance-spot")
    t.shutdown()
    print("recent:", [(r["seq"], r["tx_hash"][:12]) for r in t.atb.recent_anchors(5)])
