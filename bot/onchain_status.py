"""Data for the dashboard "On-chain" tab (Phase 1b).

    from bot.onchain_status import onchain_tab
    data = onchain_tab(bridge)          # dict, JSON-serialisable; render in FastAPI / the PWA

FastAPI example:
    @app.get("/api/onchain")
    def api_onchain(): return onchain_tab(bridge)

`recent` is served from the bridge's local JSONL log (no chain scan). `verify_recent(bridge)` optionally
re-checks those tx hashes against the chain and marks each entry `verified: true/false`.
"""
from __future__ import annotations

import time

from .atb_bridge import ATBBridge, _hex


def onchain_tab(bridge: ATBBridge, recent: int = 20) -> dict:
    st = bridge.status()
    rows = bridge.recent_anchors(recent)
    return {
        "generated_at": int(time.time()),
        "agent": st["agent"],
        "contract": st["contract"],
        "explorer_agent": st["explorer"],
        "explorer_contract": f"{bridge.explorer}/address/{st['contract']}",
        "registered": st["registered"],
        "frozen": st["frozen"],
        "reputation": st["reputation"],
        "bond_atb": st["bond_atb"],
        "daily_limit_atb": st["daily_limit_atb"],
        "remaining_allowance_atb": st["remaining_allowance_atb"],
        "anchor_count": st["anchor_count"],
        "slash_count": st["slash_count"],
        "gas_bnb": st["gas_bnb"],
        "queue": {"queued": st["queued"], "failed": st["failed"]},
        "recent": [
            {
                "seq": r.get("seq"),
                "hash": r.get("trade_hash"),
                "tx": r.get("tx_hash"),
                "tx_url": r.get("explorer_tx"),
                "block": r.get("block"),
                "timestamp": r.get("timestamp"),
                "symbol": r.get("trade", {}).get("symbol"),
                "side": r.get("trade", {}).get("side"),
                "market": r.get("trade", {}).get("market"),
            }
            for r in rows
        ],
    }


def verify_recent(bridge: ATBBridge, recent: int = 20) -> list[dict]:
    """Re-read each recent anchor's receipt and confirm the TradeAnchored event carries the same hash."""
    out = []
    for r in bridge.recent_anchors(recent):
        try:
            rc = bridge.sdk.w3.eth.get_transaction_receipt(r["tx_hash"])
            evs = bridge.sdk.c.events.TradeAnchored().process_receipt(rc)
            ok = any(_hex(e["args"]["logHash"]) == r["trade_hash"] for e in evs)
        except Exception:
            ok = False
        out.append({**r, "verified": ok})
    return out


if __name__ == "__main__":
    import json

    b = ATBBridge.from_env()
    print(json.dumps(onchain_tab(b), indent=2))
    print(json.dumps([{k: v for k, v in x.items() if k in ("seq", "tx_hash", "verified")} for x in verify_recent(b)], indent=2))
