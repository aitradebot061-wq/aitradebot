"""Public track record: delayed, verifiable trade log for the site (site/data/track-record.json).

Every fill is anchored on-chain the moment it happens (hash only). The trade details are revealed here
later, once the position they belong to has been closed for `delay_hours` (default 24h). So:

  * the record cannot be edited after the fact: each revealed record must hash to the value anchored at fill time,
    and the published hash list must chain to the on-chain `anchorHead`;
  * it is not a live signal: nothing about an open position, or one closed less than `delay_hours` ago, is shown;
  * only crypto markets are revealed. Fills from other markets keep their hash in the list (the chain stays
    verifiable) but their details are withheld.

Returns are reported per round trip, in percent of the capital that trade used, net of fees. No account size and
no money amounts are computed or shown.

    python -m bot.track_record build              # write site/data/track-record.json from the local anchor log
    python -m bot.track_record publish            # build, then commit + push that one file if it changed

Env: ATB_NETWORK (bscTestnet), ATB_ANCHOR_LOG, ATB_TRACK_DELAY_HOURS (24), ATB_FEE_RATE (0.001 per side, used when
a fill carries no `fee`), ATB_TRACK_OUT. No private key or RPC is needed: everything comes from the local log.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sdk" / "python"))
sys.path.insert(0, str(ROOT))
from aitradebot import AITradeBot  # noqa: E402
from bot.atb_bridge import _load_dotenv, load_deployment, public_record  # noqa: E402

PUBLISHED_MARKETS = {"crypto", "binance-spot", "binance-futures"}
TEST_MARKETS = {"test"}
SIDE_SIGN = {"BUY": 1, "COVER": 1, "SELL": -1, "SHORT": -1}
EXPLORERS = {97: "https://testnet.bscscan.com", 56: "https://bscscan.com"}
EPS = 1e-9


def parse_ts(ts: str) -> float:
    return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()


def is_test(trade: dict) -> bool:
    return trade.get("market") in TEST_MARKETS or trade.get("mode", "live") != "live"


# ---------- round trips ----------
def build_trips(fills: list[tuple[int, dict]], fee_rate: float) -> list[dict]:
    """Pair fills into round trips per (market, symbol): a trip opens when the position leaves zero and closes when
    it returns to zero. A fill that flips the position is split between the closing and the new trip.
    Mirrors buildTrips() in site/track-record.js."""
    trips: list[dict] = []
    book: dict[tuple, dict] = {}
    for seq, t in fills:
        sign = SIDE_SIGN.get(str(t.get("side", "")).upper())
        qty, price = float(t.get("qty", 0) or 0), float(t.get("price", 0) or 0)
        if sign is None or qty <= 0 or price <= 0:
            continue
        fee_total = float(t["fee"]) if "fee" in t else qty * price * fee_rate
        key = (t.get("market"), t.get("symbol"))
        remaining = qty
        while remaining > EPS:
            cur = book.get(key)
            if cur is None:
                cur = {"market": key[0], "symbol": key[1], "dir": "long" if sign > 0 else "short", "pos": 0.0,
                       "seqs": [], "open_ts": t["ts"], "close_ts": None, "entry_notional": 0.0, "cash": 0.0,
                       "fees": 0.0, "estimated_fees": False}
                book[key] = cur
                trips.append(cur)
            opening = (cur["pos"] >= 0) == (sign > 0) or abs(cur["pos"]) < EPS
            part = remaining if opening else min(remaining, abs(cur["pos"]))
            if seq not in cur["seqs"]:
                cur["seqs"].append(seq)
            cur["pos"] += sign * part
            cur["cash"] -= sign * part * price
            cur["fees"] += fee_total * part / qty
            cur["estimated_fees"] |= "fee" not in t
            if opening:
                cur["entry_notional"] += part * price
            remaining -= part
            if abs(cur["pos"]) < EPS * max(1.0, qty):
                cur["pos"] = 0.0
                cur["close_ts"] = t["ts"]
                cur["pnl_net"] = cur["cash"] - cur["fees"]
                cur["return_pct"] = 100.0 * cur["pnl_net"] / cur["entry_notional"]
                del book[key]
    for tr in trips:
        tr.pop("cash", None)
    return trips


def summarize(trips: list[dict]) -> dict:
    """Stats over closed trips, in percent. Cumulative = sum of per-trade returns (not compounded, not an account
    return). Mirrors summarize() in site/track-record.js."""
    closed = [t for t in trips if t.get("close_ts")]
    closed.sort(key=lambda t: parse_ts(t["close_ts"]))
    rets = [t["return_pct"] for t in closed]
    wins = [r for r in rets if r > 0]
    losses = [r for r in rets if r <= 0]
    cum, peak, mdd = 0.0, 0.0, 0.0
    for r in rets:
        cum += r
        peak = max(peak, cum)
        mdd = max(mdd, peak - cum)
    return {
        "trades": len(rets),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_pct": 100.0 * len(wins) / len(rets) if rets else None,
        "cumulative_pct": cum,
        "avg_win_pct": sum(wins) / len(wins) if wins else None,
        "avg_loss_pct": sum(losses) / len(losses) if losses else None,
        "max_drawdown_pct": mdd,
        "profit_factor": (sum(wins) / -sum(losses)) if losses and sum(losses) < 0 else None,
    }


# ---------- snapshot ----------
def load_anchor_log(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    return sorted(rows, key=lambda r: r.get("seq", 0))


def build_snapshot(rows: list[dict], *, agent: str, contract: str, chain_id: int, delay_hours: float = 24.0,
                   fee_rate: float = 0.001, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    delay = delay_hours * 3600
    pub = [(r["seq"], public_record(r["trade"])) for r in rows]
    crypto = [(s, t) for s, t in pub if t.get("market") in PUBLISHED_MARKETS and not is_test(t)]
    trips = build_trips(crypto, fee_rate)

    # A fill is revealed only when every trip it belongs to is (a flip fill sits in two trips).
    rank = {"revealed": 0, "delayed": 1, "open": 2}
    status_of: dict[int, dict] = {}
    for tr in trips:
        if not tr["close_ts"]:
            st = {"status": "open"}
        elif parse_ts(tr["close_ts"]) + delay > now:
            st = {"status": "delayed", "reveal_after": int(parse_ts(tr["close_ts"]) + delay)}
        else:
            st = {"status": "revealed"}
        for s in tr["seqs"]:
            prev = status_of.get(s)
            if prev is None or rank[st["status"]] > rank[prev["status"]]:
                status_of[s] = dict(st)
            elif st["status"] == prev["status"] == "delayed":
                prev["reveal_after"] = max(prev["reveal_after"], st["reveal_after"])

    anchors, hashes = [], []
    for r, (seq, t) in zip(rows, pub):
        canon = AITradeBot.canonical_json(t)
        h = "0x" + AITradeBot.trade_hash(t).hex()
        if h != r.get("trade_hash"):
            raise ValueError(f"anchor #{seq}: log hash does not match its record; refusing to publish")
        hashes.append(h)
        a = {"seq": seq, "trade_hash": h, "tx_hash": r.get("tx_hash"), "block": r.get("block"),
             "timestamp": r.get("timestamp")}
        if is_test(t):
            a.update(status="test", canon=canon)
        elif t.get("market") not in PUBLISHED_MARKETS:
            a.update(status="withheld")
        else:
            st = status_of.get(seq, {"status": "revealed"})  # unpaired fill (zero qty/price): nothing to hide
            a.update(st)
            if st["status"] == "revealed":
                a["canon"] = canon
        anchors.append(a)

    revealed_seqs = {a["seq"] for a in anchors if a["status"] == "revealed"}
    shown = [tr for tr in trips if tr["close_ts"] and set(tr["seqs"]) <= revealed_seqs]
    return {
        "version": 1,
        "generated_at": int(now),
        "chain_id": chain_id,
        "explorer": EXPLORERS.get(chain_id, EXPLORERS[97]),
        "contract": contract,
        "agent": agent,
        "delay_hours": delay_hours,
        "fee_rate": fee_rate,
        "published_markets": sorted(PUBLISHED_MARKETS),
        "anchor_count": len(anchors),
        "anchor_head": "0x" + AITradeBot.chain_head(hashes).hex(),
        "summary": summarize(shown),
        "anchors": anchors,
    }


def _config() -> dict:
    _load_dotenv(ROOT / ".env")
    network = os.environ.get("ATB_NETWORK", "bscTestnet")
    dep = load_deployment(network)
    return {
        "network": network,
        "chain_id": int(dep.get("chainId", 97)),
        "contract": os.environ.get("ATB_CONTRACT") or dep["token"],
        "agent": os.environ.get("ATB_AGENT") or dep.get("agent", {}).get("address", ""),
        "log": Path(os.environ.get("ATB_ANCHOR_LOG", str(ROOT / "bot" / f"anchors.{network}.jsonl"))),
        "out": Path(os.environ.get("ATB_TRACK_OUT", str(ROOT / "site" / "data" / "track-record.json"))),
        "delay_hours": float(os.environ.get("ATB_TRACK_DELAY_HOURS", "24")),
        "fee_rate": float(os.environ.get("ATB_FEE_RATE", "0.001")),
    }


def build(cfg: dict | None = None) -> dict:
    cfg = cfg or _config()
    snap = build_snapshot(load_anchor_log(cfg["log"]), agent=cfg["agent"], contract=cfg["contract"],
                          chain_id=cfg["chain_id"], delay_hours=cfg["delay_hours"], fee_rate=cfg["fee_rate"])
    cfg["out"].parent.mkdir(parents=True, exist_ok=True)
    cfg["out"].write_text(json.dumps(snap, indent=1, ensure_ascii=True) + "\n", encoding="utf-8")
    return snap


def _git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *args], check=True, capture_output=True, text=True).stdout.strip()


def publish() -> str:
    """Build, then commit and push only the snapshot file. Refuses to run under any git identity other than the
    project's, so a server misconfiguration can never put a personal name into the public history."""
    cfg = _config()
    if _git("config", "user.name") != "AI Trade Bot":
        raise SystemExit("git user.name is not 'AI Trade Bot' in this repo; refusing to commit")
    if not _git("config", "user.email").endswith("@users.noreply.github.com"):
        raise SystemExit("git user.email is not a GitHub noreply address in this repo; refusing to commit")
    snap = build(cfg)
    rel = cfg["out"].resolve().relative_to(ROOT).as_posix()
    _git("add", "--", rel)
    if not _git("diff", "--cached", "--name-only", "--", rel):
        return "unchanged"
    revealed = sum(1 for a in snap["anchors"] if a["status"] == "revealed")
    _git("commit", "-m", f"Track record: {snap['anchor_count']} anchors, {revealed} revealed", "--", rel)
    _git("push", "origin", "HEAD")
    return "pushed"


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="ATB public track record")
    p.add_argument("cmd", choices=["build", "publish"])
    a = p.parse_args()
    if a.cmd == "build":
        s = build()
        print(json.dumps({k: s[k] for k in ("anchor_count", "anchor_head", "summary")}, indent=2))
    else:
        print(publish())
