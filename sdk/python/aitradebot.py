"""AITradeBot Python SDK (web3.py v6+).

pip install web3

    from aitradebot import AITradeBot
    atb = AITradeBot(rpc, contract_address, private_key)   # operator or agent key
    atb.register_agent(agent_addr, {"model": "gpt-x", "policy": "..."}, bond=5000, daily_limit=1000)
    atb.safe_pay(counterparty, 300, min_reputation=1000)   # checks rep + allowance first
"""
import json, hashlib, os
from pathlib import Path
from web3 import Web3

ABI = json.loads((Path(__file__).resolve().parent.parent / "abi.json").read_text())


class AITradeBot:
    def __init__(self, rpc_url: str, contract: str, private_key: str | None = None):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        # BNB Chain is PoA: block extraData exceeds 32 bytes, so web3.py needs the PoA middleware.
        try:
            from web3.middleware import ExtraDataToPOAMiddleware as _poa  # web3 v7
        except ImportError:
            from web3.middleware import geth_poa_middleware as _poa  # web3 v6
        self.w3.middleware_onion.inject(_poa, layer=0)
        self.c = self.w3.eth.contract(address=Web3.to_checksum_address(contract), abi=ABI)
        self.acct = self.w3.eth.account.from_key(private_key) if private_key else None
        self.dec = self.c.functions.decimals().call()

    # ---------- helpers ----------
    def to_wei(self, n): return int(n * 10 ** self.dec)
    def from_wei(self, n): return n / 10 ** self.dec

    @staticmethod
    def metadata_hash(meta: dict) -> bytes:
        return hashlib.sha256(json.dumps(meta, sort_keys=True).encode()).digest()

    def _send(self, fn):
        if not self.acct:
            raise RuntimeError("private key required for write calls")
        tx = fn.build_transaction({
            "from": self.acct.address,
            "nonce": self.w3.eth.get_transaction_count(self.acct.address),
        })
        signed = self.acct.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        return self.w3.eth.wait_for_transaction_receipt(h)

    # ---------- reads ----------
    def agent(self, addr):
        a = self.c.functions.agents(Web3.to_checksum_address(addr)).call()
        keys = ["operator", "metadataHash", "bond", "dailyLimit", "spentToday", "windowStart",
                "registeredAt", "slashCount", "unbondRequestedAt", "anchorCount", "frozen", "registered"]
        d = dict(zip(keys, a)); d["bond"] = self.from_wei(d["bond"]); d["dailyLimit"] = self.from_wei(d["dailyLimit"])
        return d

    def reputation(self, addr): return self.c.functions.reputation(Web3.to_checksum_address(addr)).call()
    def remaining_allowance(self, addr): return self.from_wei(self.c.functions.remainingDailyAllowance(Web3.to_checksum_address(addr)).call())
    def balance(self, addr): return self.from_wei(self.c.functions.balanceOf(Web3.to_checksum_address(addr)).call())

    # ---------- operator actions ----------
    def register_agent(self, agent, meta: dict, bond, daily_limit):
        return self._send(self.c.functions.registerAgent(Web3.to_checksum_address(agent), self.metadata_hash(meta), self.to_wei(bond), self.to_wei(daily_limit)))
    def set_daily_limit(self, agent, limit): return self._send(self.c.functions.setDailyLimit(Web3.to_checksum_address(agent), self.to_wei(limit)))
    def freeze(self, agent): return self._send(self.c.functions.freezeAgent(Web3.to_checksum_address(agent)))
    def unfreeze(self, agent): return self._send(self.c.functions.unfreezeAgent(Web3.to_checksum_address(agent)))
    def increase_bond(self, agent, amount): return self._send(self.c.functions.increaseBond(Web3.to_checksum_address(agent), self.to_wei(amount)))
    def post_bounty(self, amount, scope: dict): return self._send(self.c.functions.postBounty(self.to_wei(amount), self.metadata_hash(scope)))
    def pay_bounty(self, bounty_id, hunter): return self._send(self.c.functions.payBounty(bounty_id, Web3.to_checksum_address(hunter)))

    # ---------- proof of performance / access ----------
    @staticmethod
    def trade_hash(trade: dict) -> bytes:
        """Deterministic hash of one trade record (symbol, side, qty, price, ts, order_id...)."""
        return hashlib.sha256(json.dumps(trade, sort_keys=True, default=str).encode()).digest()
    def anchor_trade(self, agent, trade: dict):
        return self._send(self.c.functions.anchorTrade(Web3.to_checksum_address(agent), self.trade_hash(trade)))
    def pay_access(self, agent, amount, plan: str = "monthly"):
        return self._send(self.c.functions.payAccess(Web3.to_checksum_address(agent), self.to_wei(amount), Web3.keccak(text=plan)))

    # ---------- agent actions ----------
    def pay(self, to, amount): return self._send(self.c.functions.transfer(Web3.to_checksum_address(to), self.to_wei(amount)))

    def safe_pay(self, to, amount, min_reputation=0, require_registered=True):
        """Agent-to-agent payment with pre-checks. Raises before spending gas."""
        info = self.agent(to)
        if require_registered and not info["registered"]:
            raise PermissionError(f"counterparty {to} is not a registered agent")
        if info["frozen"]:
            raise PermissionError("counterparty is frozen")
        if self.reputation(to) < min_reputation:
            raise PermissionError(f"counterparty reputation {self.reputation(to)} < {min_reputation}")
        if self.remaining_allowance(self.acct.address) < amount:
            raise ValueError("would exceed my daily limit")
        return self.pay(to, amount)


if __name__ == "__main__":
    atb = AITradeBot(os.environ["RPC"], os.environ["ATB"], os.environ.get("PRIVATE_KEY"))
    print("rep:", atb.reputation(os.environ["AGENT"]))
