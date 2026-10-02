"""Index AccessPaid events into 30-day access grants keyed by payer wallet (Phase 1b backend).

    python -m bot.access_indexer                # one pass (cursor persisted in bot/access.<network>.json)
    python -m bot.access_indexer --loop 60      # poll every 60 s

    from bot.access_indexer import AccessIndex
    idx = AccessIndex.from_env(); idx.sync()
    idx.has_access("0xPayer")                    # -> True/False
    idx.grant("0xPayer")                         # -> {"agent", "plan", "amount_atb", "paid_at", "expires_at", "tx"}

Rules (docs/PRICING.md): a payment extends access by GRANT_DAYS from max(now, current expiry), so
renewing early does not lose time. Plan ids are keccak(plan_name); known names are mapped back.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from web3 import Web3

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sdk" / "python"))
from aitradebot import AITradeBot  # noqa: E402

from .atb_bridge import _hex, _load_dotenv, load_deployment  # noqa: E402

GRANT_DAYS = 30
PLAN_NAMES = ["monthly", "standard", "pro", "free"]
PLAN_BY_HASH = {_hex(Web3.keccak(text=n)): n for n in PLAN_NAMES}
CHUNK = int(os.environ.get("ATB_LOG_CHUNK", "5000"))  # eth_getLogs block span per call
# The bnbchain data-seed RPCs reject eth_getLogs entirely ("limit exceeded"); publicnode serves 5000-block ranges.
LOGS_RPC = {97: "https://bsc-testnet-rpc.publicnode.com", 56: "https://bsc-rpc.publicnode.com"}


class AccessIndex:
    def __init__(self, rpc_url: str, contract: str, state_path: Path, start_block: int):
        self.sdk = AITradeBot(rpc_url, contract)
        self.state_path = state_path
        self.state = {"cursor": start_block, "grants": {}}
        if state_path.exists():
            self.state = json.loads(state_path.read_text(encoding="utf-8"))

    @classmethod
    def from_env(cls, network: str | None = None) -> "AccessIndex":
        _load_dotenv(ROOT / ".env")
        network = network or os.environ.get("ATB_NETWORK", "bscTestnet")
        dep = load_deployment(network)
        rpc = os.environ.get("ATB_LOGS_RPC") or LOGS_RPC[int(dep.get("chainId", 97))]
        start = int(os.environ.get("ATB_START_BLOCK") or dep.get("deployBlock") or 0)
        return cls(rpc, dep["token"], ROOT / "bot" / f"access.{network}.json", start)

    def _save(self) -> None:
        self.state_path.write_text(json.dumps(self.state, indent=2), encoding="utf-8")

    def sync(self, to_block: int | None = None) -> int:
        """Scan new blocks; return number of AccessPaid events applied."""
        w3 = self.sdk.w3
        head = to_block if to_block is not None else w3.eth.block_number
        frm = int(self.state["cursor"])
        if frm == 0:  # no deploy block recorded: start a day back rather than from genesis
            frm = max(head - 28800, 0)
        applied = 0
        chunk = CHUNK
        while frm <= head:
            to = min(frm + chunk - 1, head)
            try:
                logs = self.sdk.c.events.AccessPaid().get_logs(from_block=frm, to_block=to)
            except Exception as e:  # "limit exceeded" / range too large on public RPCs: back off and halve
                if chunk > 50 and ("limit" in str(e).lower() or "range" in str(e).lower()):
                    chunk //= 2
                    time.sleep(0.5)
                    continue
                self._save()
                raise
            for ev in sorted(logs, key=lambda e: (e["blockNumber"], e["logIndex"])):
                self._apply(ev)
                applied += 1
            frm = to + 1
            self.state["cursor"] = frm
            if frm <= head:
                time.sleep(0.15)  # stay under public RPC rate limits
        self._save()
        return applied

    def _apply(self, ev) -> None:
        a = ev["args"]
        payer = Web3.to_checksum_address(a["payer"])
        paid_at = int(self.sdk.w3.eth.get_block(ev["blockNumber"])["timestamp"])
        cur = self.state["grants"].get(payer)
        base = max(paid_at, int(cur["expires_at"])) if cur else paid_at
        plan_hex = _hex(a["plan"])
        self.state["grants"][payer] = {
            "agent": a["agent"],
            "plan": PLAN_BY_HASH.get(plan_hex, plan_hex),
            "amount_atb": self.sdk.from_wei(int(a["amount"])),
            "paid_at": paid_at,
            "expires_at": base + GRANT_DAYS * 86400,
            "tx": _hex(ev["transactionHash"]),
            "block": int(ev["blockNumber"]),
        }

    def grant(self, payer: str) -> dict | None:
        return self.state["grants"].get(Web3.to_checksum_address(payer))

    def has_access(self, payer: str, now: int | None = None) -> bool:
        g = self.grant(payer)
        return bool(g) and int(g["expires_at"]) > (now or int(time.time()))


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--network", default=None)
    p.add_argument("--loop", type=int, default=0, help="poll interval seconds (0 = one pass)")
    a = p.parse_args()
    idx = AccessIndex.from_env(a.network)
    while True:
        n = idx.sync()
        print(f"cursor {idx.state['cursor']}  applied {n}  grants {len(idx.state['grants'])}")
        if not a.loop:
            break
        time.sleep(a.loop)
