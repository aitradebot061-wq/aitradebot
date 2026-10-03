"""ATB bridge for the quant bot (Phase 1b).

Drop-in layer between live_trader.py and the AITradeBot contract.

    from bot.atb_bridge import ATBBridge
    atb = ATBBridge.from_env()            # ATB_RPC / ATB_CONTRACT / BOT_PRIVATE_KEY (.env or environment)

    # before every order
    g = atb.guard(amount_atb=0)           # cached on-chain read (frozen flag + remaining daily allowance)
    if not g.ok:
        log.warning("order skipped: %s", g.reason); return

    # after every fill (non-blocking: queued to a background thread)
    atb.anchor_fill({"symbol": "BTCUSDT", "side": "BUY", "qty": 0.01, "price": 63120.5,
                     "ts": "2026-10-01T09:30:00Z", "order_id": "123", "market": "binance-spot"})

Every anchored fill is appended to a local JSONL log (trade, sha256 hash, tx hash, seq, block) so the
dashboard can show anchors with BscScan links without re-scanning the chain.
"""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
from dataclasses import dataclass, asdict, field, replace
from pathlib import Path
from typing import Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "sdk" / "python"))
from aitradebot import AITradeBot  # noqa: E402

EXPLORERS = {97: "https://testnet.bscscan.com", 56: "https://bscscan.com"}
# Only these fields of a fill are hashed, anchored and published. Everything else the bot passes
# (strategy name, session, model, interval...) stays in the private local log and never affects the hash,
# so the public trade log can be released for verification without revealing the strategy.
PUBLIC_TRADE_FIELDS = ("symbol", "side", "qty", "price", "ts", "order_id", "market", "mode")


def public_record(trade: dict) -> dict:
    return {k: trade[k] for k in PUBLIC_TRADE_FIELDS if k in trade}


DEFAULT_RPC = {97: "https://data-seed-prebsc-1-s1.bnbchain.org:8545", 56: "https://bsc-dataseed.bnbchain.org"}


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (no dependency). Existing environment wins."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def load_deployment(network: str = "bscTestnet") -> dict:
    return json.loads((ROOT / "deployments" / f"{network}.json").read_text(encoding="utf-8"))


def _hex(x) -> str:
    h = x.hex() if hasattr(x, "hex") else str(x)
    return h if h.startswith("0x") else "0x" + h


@dataclass
class GuardResult:
    ok: bool
    reason: str
    frozen: bool
    registered: bool
    remaining_allowance: float
    checked_at: float
    unbonding: bool = False

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class AnchorResult:
    trade: dict
    trade_hash: str
    tx_hash: str
    seq: int
    block: int
    timestamp: int
    explorer_tx: str
    gas_used: int
    private: dict = field(default_factory=dict)  # non-public fields; local log only, never hashed

    def as_dict(self) -> dict:
        return asdict(self)


class ATBBridge:
    def __init__(
        self,
        rpc_url: str,
        contract: str,
        agent_private_key: str,
        *,
        chain_id: int = 97,
        log_path: str | os.PathLike = "atb_anchors.jsonl",
        guard_ttl: float = 10.0,
        max_retries: int = 3,
        on_anchor: Optional[Callable[[AnchorResult], None]] = None,
        on_error: Optional[Callable[[dict, Exception], None]] = None,
    ):
        self.sdk = AITradeBot(rpc_url, contract, agent_private_key)
        self.agent = self.sdk.acct.address
        self.chain_id = chain_id
        self.explorer = EXPLORERS.get(chain_id, EXPLORERS[97])
        self.log_path = Path(log_path)
        self.guard_ttl = guard_ttl
        self.max_retries = max_retries
        self.on_anchor = on_anchor
        self.on_error = on_error

        self._guard_cache: Optional[GuardResult] = None
        self._send_lock = threading.Lock()
        self._q: "queue.Queue[dict]" = queue.Queue()
        self._worker: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self.pending_failures: list[dict] = []

    # ---------- construction ----------
    @classmethod
    def from_env(cls, network: str | None = None, **kw) -> "ATBBridge":
        _load_dotenv(ROOT / ".env")
        network = network or os.environ.get("ATB_NETWORK", "bscTestnet")
        dep = load_deployment(network)
        chain_id = int(dep.get("chainId", 97))
        rpc = os.environ.get("ATB_RPC") or DEFAULT_RPC[chain_id]
        contract = os.environ.get("ATB_CONTRACT") or dep["token"]
        key = os.environ.get("BOT_PRIVATE_KEY")
        if not key:
            raise RuntimeError("BOT_PRIVATE_KEY not set (run scripts/register-agent.js first)")
        kw.setdefault("log_path", os.environ.get("ATB_ANCHOR_LOG", str(ROOT / "bot" / f"anchors.{network}.jsonl")))
        return cls(rpc, contract, key, chain_id=chain_id, **kw)

    # ---------- pre-order guard ----------
    def guard(self, amount_atb: float = 0.0, force: bool = False) -> GuardResult:
        """Return ok=False if the agent is frozen, unregistered, or `amount_atb` would exceed the daily cap.

        Reads are cached for `guard_ttl` seconds so calling this before every order is cheap.
        If the RPC is unreachable and no cache exists, returns ok=False (fail closed).
        """
        now = time.time()
        c = self._guard_cache
        if c is not None and not force and now - c.checked_at < self.guard_ttl:
            return self._evaluate(c, amount_atb)
        try:
            info = self.sdk.agent(self.agent)
            remaining = self.sdk.remaining_allowance(self.agent) if info["registered"] else 0.0
            c = GuardResult(True, "ok", bool(info["frozen"]), bool(info["registered"]), remaining, now,
                            unbonding=bool(info["unbondRequestedAt"]))
        except Exception as e:  # RPC error
            if c is not None:
                stale = replace(c, reason=f"stale ({e.__class__.__name__})")
                return self._evaluate(stale, amount_atb)
            return GuardResult(False, f"rpc error: {e}", False, False, 0.0, now)
        self._guard_cache = c
        return self._evaluate(c, amount_atb)

    @staticmethod
    def _evaluate(c: GuardResult, amount_atb: float) -> GuardResult:
        if not c.registered:
            return replace(c, ok=False, reason="agent not registered")
        if c.frozen:
            return replace(c, ok=False, reason="agent frozen (kill switch)")
        if c.unbonding:
            return replace(c, ok=False, reason="agent unbonding (anchoring disabled)")
        if amount_atb > c.remaining_allowance:
            return replace(c, ok=False, reason=f"daily cap: {amount_atb} > remaining {c.remaining_allowance}")
        return c

    def is_frozen(self) -> bool:
        return self.guard(force=True).frozen

    # ---------- anchoring ----------
    @staticmethod
    def trade_hash_hex(trade: dict) -> str:
        """Hash of the PUBLIC part of a fill (see PUBLIC_TRADE_FIELDS)."""
        return "0x" + AITradeBot.trade_hash(public_record(trade)).hex()

    def anchor_now(self, trade: dict) -> AnchorResult:
        """Synchronous anchor with retries. Raises on final failure.

        Only public_record(trade) is hashed and anchored; the other fields go to the local log as `private`."""
        private = {k: v for k, v in trade.items() if k not in PUBLIC_TRADE_FIELDS}
        trade = public_record(trade)
        last: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                with self._send_lock:
                    rc = self.sdk.anchor_trade(self.agent, trade)
                ev = self.sdk.c.events.TradeAnchored().process_receipt(rc)
                seq = int(ev[0]["args"]["seq"]) if ev else -1
                ts = int(ev[0]["args"]["timestamp"]) if ev else 0
                tx_hash = _hex(rc["transactionHash"])
                res = AnchorResult(
                    trade=trade,
                    trade_hash=self.trade_hash_hex(trade),
                    tx_hash=tx_hash,
                    seq=seq,
                    block=int(rc["blockNumber"]),
                    timestamp=ts,
                    explorer_tx=f"{self.explorer}/tx/{tx_hash}",
                    gas_used=int(rc["gasUsed"]),
                    private=private,
                )
                self._append_log(res)
                if self.on_anchor:
                    self.on_anchor(res)
                return res
            except Exception as e:
                last = e
                msg = str(e)
                if any(x in msg for x in ("agent frozen", "not registered", "not agent", "unbonding")):
                    break  # permanent; retrying will not help
                time.sleep(min(2 ** attempt, 10))
        assert last is not None
        self.pending_failures.append({"trade": {**trade, **private}, "error": str(last), "at": time.time()})
        if self.on_error:
            self.on_error(trade, last)
        raise last

    def anchor_fill(self, trade: dict) -> None:
        """Non-blocking: queue the fill; a daemon thread anchors it in order."""
        self._ensure_worker()
        self._q.put(trade)

    def _ensure_worker(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._stop.clear()
        self._worker = threading.Thread(target=self._run, name="atb-anchor", daemon=True)
        self._worker.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                trade = self._q.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self.anchor_now(trade)
            except Exception:
                pass  # recorded in pending_failures / on_error
            finally:
                self._q.task_done()

    def flush(self, timeout: float | None = None) -> None:
        """Block until every queued fill has been anchored (call on shutdown)."""
        if not (self._worker and self._worker.is_alive()):
            return
        if timeout is None:
            self._q.join()
            return
        end = time.time() + timeout
        while self._q.unfinished_tasks and time.time() < end:
            time.sleep(0.2)

    def close(self) -> None:
        self.flush()
        self._stop.set()

    # ---------- local log ----------
    def _append_log(self, res: AnchorResult) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(res.as_dict(), default=str) + "\n")

    def recent_anchors(self, n: int = 20) -> list[dict]:
        if not self.log_path.exists():
            return []
        lines = self.log_path.read_text(encoding="utf-8").splitlines()
        out = [json.loads(x) for x in lines[-n:] if x.strip()]
        return list(reversed(out))

    def all_anchors(self) -> list[dict]:
        """Every locally logged anchor, ordered by seq."""
        if not self.log_path.exists():
            return []
        rows = [json.loads(x) for x in self.log_path.read_text(encoding="utf-8").splitlines() if x.strip()]
        return sorted(rows, key=lambda r: r.get("seq", 0))

    # ---------- status ----------
    def status(self) -> dict:
        info = self.sdk.agent(self.agent)
        return {
            "agent": self.agent,
            "chain_id": self.chain_id,
            "contract": self.sdk.c.address,
            "registered": bool(info["registered"]),
            "frozen": bool(info["frozen"]),
            "unbonding": bool(info["unbondRequestedAt"]),
            "anchor_head": _hex(self.sdk.anchor_head(self.agent)),
            "operator": info["operator"],
            "bond_atb": info["bond"],
            "daily_limit_atb": info["dailyLimit"],
            "remaining_allowance_atb": self.sdk.remaining_allowance(self.agent) if info["registered"] else 0.0,
            "anchor_count": int(info["anchorCount"]),
            "slash_count": int(info["slashCount"]),
            "reputation": int(self.sdk.reputation(self.agent)),
            "gas_bnb": self.sdk.w3.eth.get_balance(self.agent) / 1e18,
            "explorer": f"{self.explorer}/address/{self.agent}",
            "queued": self._q.qsize(),
            "failed": len(self.pending_failures),
        }


# ---------- CLI ----------
if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="ATB bridge CLI")
    p.add_argument("cmd", choices=["status", "guard", "anchor-test", "recent"])
    p.add_argument("--network", default=None)
    a = p.parse_args()
    b = ATBBridge.from_env(a.network)
    if a.cmd == "status":
        print(json.dumps(b.status(), indent=2))
    elif a.cmd == "guard":
        print(json.dumps(b.guard(force=True).as_dict(), indent=2))
    elif a.cmd == "recent":
        print(json.dumps(b.recent_anchors(), indent=2))
    elif a.cmd == "anchor-test":
        fill = {"symbol": "BTCUSDT", "side": "BUY", "qty": 0.001, "price": 0, "market": "test",
                "order_id": f"selftest-{int(time.time())}", "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        g = b.guard()
        print("guard:", g.reason, "| remaining", g.remaining_allowance)
        if g.ok:
            r = b.anchor_now(fill)
            print(json.dumps(r.as_dict(), indent=2))
