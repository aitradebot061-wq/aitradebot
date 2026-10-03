"""Data for the dashboard "On-chain" tab (Phase 1b).

    from bot.onchain_status import onchain_tab
    data = onchain_tab(bridge)          # dict, JSON-serialisable; render in FastAPI / the PWA

FastAPI example:
    @app.get("/api/onchain")
    def api_onchain(): return onchain_tab(bridge)

`recent` is served from the bridge's local JSONL log (no chain scan). `verify_recent(bridge)` optionally
re-checks those tx hashes against the chain and marks each entry `verified: true/false`.

`verify_chain(bridge)` recomputes the whole anchor hash chain from the local log and compares it with the
on-chain `anchorHead`, which proves the log is complete (no gaps, no reordering, no edits).
`export_public_log(bridge, path)` writes the publishable log (public trade fields only) that anyone can
check with the same recomputation.
"""
from __future__ import annotations

import time

import json
from pathlib import Path

from .atb_bridge import ATBBridge, _hex, public_record
from aitradebot import AITradeBot


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
        "unbonding": st["unbonding"],
        "anchor_head": st["anchor_head"],
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


def verify_chain(bridge: ATBBridge) -> dict:
    """Recompute keccak chain over every logged trade hash (re-hashed from the public record) and compare
    with the on-chain head. ok=True means the local log is exactly the anchored history: complete and unedited."""
    rows = bridge.all_anchors()
    seqs = [r.get("seq") for r in rows]
    gaps = [i for i, s in enumerate(seqs, start=1) if s != i]
    rehashed = ["0x" + AITradeBot.trade_hash(public_record(r["trade"])).hex() for r in rows]
    mismatched = [r.get("seq") for r, h in zip(rows, rehashed) if h != r.get("trade_hash")]
    local_head = _hex(AITradeBot.chain_head(rehashed))
    chain_head = _hex(bridge.sdk.anchor_head(bridge.agent))
    on_chain_count = int(bridge.sdk.agent(bridge.agent)["anchorCount"])
    return {
        "ok": local_head == chain_head and not gaps and not mismatched and len(rows) == on_chain_count,
        "logged": len(rows),
        "on_chain_count": on_chain_count,
        "local_head": local_head,
        "chain_head": chain_head,
        "seq_gaps_at": gaps[:20],
        "hash_mismatch_seq": mismatched[:20],
    }


def export_public_log(bridge: ATBBridge, path: str | Path) -> int:
    """Write the publishable trade log: seq, public trade record, hash, tx. No private fields."""
    rows = bridge.all_anchors()
    out = [{"seq": r.get("seq"), "trade": public_record(r["trade"]), "trade_hash": r.get("trade_hash"),
            "tx_hash": r.get("tx_hash"), "block": r.get("block"), "timestamp": r.get("timestamp")} for r in rows]
    Path(path).write_text(json.dumps({"agent": bridge.agent, "contract": bridge.sdk.c.address,
                                      "chain_id": bridge.chain_id, "anchors": out}, indent=1), encoding="utf-8")
    return len(out)


if __name__ == "__main__":
    b = ATBBridge.from_env()
    print(json.dumps(onchain_tab(b), indent=2))
    print(json.dumps(verify_chain(b), indent=2))
    print(json.dumps([{k: v for k, v in x.items() if k in ("seq", "tx_hash", "verified")} for x in verify_recent(b)], indent=2))
