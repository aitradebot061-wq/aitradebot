// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * AI Trade Bot (ATB) — BEP-20 token for verified AI trading agents.
 *
 *  A trading bot registers as an agent, posts an ATB bond, and runs under a daily
 *  spend cap and an operator kill switch. Trade-log hashes are anchored on-chain
 *  into a per-agent hash chain so performance is verifiable. ATB is a utility token:
 *  access, bond, bounties. It carries no profit share and never pools user funds.
 *
 *  Supply guarantees (enforced by code, not policy):
 *  - Fixed supply: the only mint is in the constructor. No mint function exists.
 *  - Deflationary: slashed bonds are 100% burned; a minimum share of every protocol
 *    fee is burned (MIN_FEE_BURN_BPS). Owner can raise the burn share, never lower
 *    it below the floor.
 *  - Fee caps: registration fee, minimum bond and bounty fee have hard maximums in code.
 *  - No blacklist, no per-address tax, no transfer restrictions except the agent
 *    rules a wallet opts into by consenting to an operator.
 *  - Bounded pause: an emergency pause lasts at most MAX_PAUSE, cannot be re-armed
 *    for PAUSE_COOLDOWN after it ends, and can be disabled forever.
 *  - Two-step ownership transfer (Ownable2Step): the new owner must accept.
 *
 *  Features:
 *  - Agent registry: an agent wallet consents to an operator (approveOperator), then the
 *    operator registers it and posts an ATB bond. No wallet can become an agent without
 *    its own transaction, so pools and third-party wallets can never be frozen or capped.
 *  - Daily spend limit: transfers FROM a registered agent are capped per 24h
 *    (limits blast radius if the agent is hijacked / prompt-injected).
 *  - Kill switch: operator (or owner, for emergencies) can freeze an agent instantly;
 *    only the operator can unfreeze.
 *  - Slashing: arbiter can slash a misbehaving agent's bond (burned). Slash and anchor
 *    history stay with the agent wallet after deregistration.
 *  - Unbonding: once requested, the agent can no longer anchor trades, so the full
 *    UNBOND_DELAY is a dispute window after its last activity.
 *  - Trade anchoring: append-only hash chain per agent (anchorHead), seq never restarts.
 *  - Access fees: users pay ATB for bot access; fee is split burn / treasury.
 *  - Bounty escrow: lock ATB as a security bounty, pay out to a hunter.
 */
contract AITradeBot is ERC20, ERC20Burnable, Ownable2Step, ReentrancyGuard {
    uint16 public constant BPS = 10_000;

    // ---------- Protocol economics (hard caps) ----------
    uint16 public constant MIN_FEE_BURN_BPS = 3_000;             // >= 30% of every fee is burned
    uint16 public constant MAX_BOUNTY_FEE_BPS = 500;             // <= 5% of bounty payouts
    uint256 public constant MAX_REGISTRATION_FEE = 1_000 ether;  // <= 1,000 ATB
    uint256 public constant MAX_MIN_BOND = 100_000 ether;        // minBond can never exceed 100,000 ATB
    uint256 public constant UNBOND_DELAY = 7 days;
    uint256 public constant WINDOW = 24 hours;

    // ---------- Bounded emergency pause ----------
    uint256 public constant MAX_PAUSE = 7 days;       // a pause expires on its own
    uint256 public constant PAUSE_COOLDOWN = 7 days;  // minimum unpaused time before the next pause
    uint256 public pausedUntil;                       // 0 = never paused
    bool public pauseDisabled;                        // true = pause() can never be called again

    // ---------- Reputation weights ----------
    uint256 public constant REP_BOND_UNIT = 100 ether; // 1 point per 100 ATB of bond ...
    uint256 public constant REP_MAX_BOND_POINTS = 100; // ... capped at 100 points (10,000 ATB)
    uint256 public constant REP_SLASH_PENALTY = 100;

    address public treasury;          // protocol treasury (multisig)
    address public arbiter;           // slashing authority (multisig / DAO)
    uint16 public feeBurnBps = 5_000; // 50% of fees burned, 50% to treasury
    uint16 public bountyFeeBps = 200; // 2% of bounty payouts
    uint256 public registrationFee = 100 ether;
    uint256 public minBond = 1_000 ether;

    // transparency counters
    uint256 public totalBurned;          // slashing + fee burns
    uint256 public totalTreasuryFees;    // fees forwarded to treasury
    uint256 public totalAccessPaid;      // gross access payments
    uint256 public agentCount;           // currently registered agents
    uint256 public totalAnchors;         // trade-log hashes anchored, all agents

    // ---------- Agent registry ----------
    struct Agent {
        address operator;      // human/org that controls this agent
        bytes32 metadataHash;  // IPFS/URL hash of agent description, model, policy
        uint256 bond;          // ATB locked as collateral
        uint256 dailyLimit;    // max ATB the agent may send per 24h (0 = unlimited)
        uint256 spentToday;
        uint256 windowStart;
        uint256 registeredAt;
        uint256 slashCount;    // lifetime, survives deregistration
        uint256 unbondRequestedAt;
        uint256 anchorCount;   // lifetime, survives deregistration (= last anchor seq)
        bool frozen;
        bool registered;
    }
    mapping(address => Agent) public agents;

    /// agent wallet => operator it consents to be registered by (one-shot, cleared on registration)
    mapping(address => address) public approvedOperator;

    /// agent wallet => head of its anchor hash chain: head' = keccak256(head, logHash). Never reset.
    mapping(address => bytes32) public anchorHead;

    // ---------- Bounties ----------
    struct Bounty {
        address poster;
        uint256 amount;
        bytes32 scopeHash;     // hash of bounty scope / rules
        bool open;
    }
    Bounty[] public bounties;

    // ---------- Events ----------
    event OperatorApproved(address indexed agent, address indexed operator);
    event AgentRegistered(address indexed agent, address indexed operator, uint256 bond, uint256 dailyLimit);
    event AgentFrozen(address indexed agent, bool frozen);
    event AgentSlashed(address indexed agent, uint256 amount, string reason);
    event BondIncreased(address indexed agent, uint256 amount);
    event UnbondRequested(address indexed agent);
    event UnbondCancelled(address indexed agent);
    event AgentDeregistered(address indexed agent, uint256 bondReturned);
    event DailyLimitUpdated(address indexed agent, uint256 newLimit);
    event TradeAnchored(address indexed agent, uint256 indexed seq, bytes32 logHash, uint256 timestamp);
    event AccessPaid(address indexed payer, address indexed agent, uint256 amount, bytes32 plan);
    event FeeTaken(address indexed from, uint256 burned, uint256 toTreasury);
    event BountyPosted(uint256 indexed id, address indexed poster, uint256 amount);
    event BountyPaid(uint256 indexed id, address indexed hunter, uint256 amount, uint256 fee);
    event BountyCancelled(uint256 indexed id);
    event ArbiterUpdated(address arbiter);
    event TreasuryUpdated(address treasury);
    event FeeParamsUpdated(uint16 feeBurnBps, uint16 bountyFeeBps, uint256 registrationFee, uint256 minBond);
    event Paused(address account, uint256 until);
    event Unpaused(address account);
    event PauseDisabledForever(address account);

    constructor(uint256 initialSupply, address initialOwner, address treasury_)
        ERC20("AI Trade Bot", "ATB")
        Ownable(initialOwner)
    {
        require(treasury_ != address(0), "zero treasury");
        _mint(initialOwner, initialSupply);
        arbiter = initialOwner;
        treasury = treasury_;
    }

    // ---------- Admin (bounded) ----------
    function setArbiter(address a) external onlyOwner { require(a != address(0), "zero"); arbiter = a; emit ArbiterUpdated(a); }
    function setTreasury(address t) external onlyOwner { require(t != address(0), "zero"); treasury = t; emit TreasuryUpdated(t); }

    function setFeeParams(uint16 feeBurnBps_, uint16 bountyFeeBps_, uint256 registrationFee_, uint256 minBond_) external onlyOwner {
        require(feeBurnBps_ >= MIN_FEE_BURN_BPS && feeBurnBps_ <= BPS, "burn share out of range");
        require(bountyFeeBps_ <= MAX_BOUNTY_FEE_BPS, "bounty fee too high");
        require(registrationFee_ <= MAX_REGISTRATION_FEE, "registration fee too high");
        require(minBond_ <= MAX_MIN_BOND, "min bond too high");
        feeBurnBps = feeBurnBps_;
        bountyFeeBps = bountyFeeBps_;
        registrationFee = registrationFee_;
        minBond = minBond_;
        emit FeeParamsUpdated(feeBurnBps_, bountyFeeBps_, registrationFee_, minBond_);
    }

    // ---------- Bounded pause ----------
    function paused() public view returns (bool) { return block.timestamp < pausedUntil; }

    /// Emergency stop for at most MAX_PAUSE. Cannot be re-armed until PAUSE_COOLDOWN after the last pause ended.
    function pause() external onlyOwner {
        require(!pauseDisabled, "pause disabled");
        require(!paused(), "already paused");
        require(pausedUntil == 0 || block.timestamp >= pausedUntil + PAUSE_COOLDOWN, "pause cooldown");
        pausedUntil = block.timestamp + MAX_PAUSE;
        emit Paused(msg.sender, pausedUntil);
    }

    function unpause() external onlyOwner {
        require(paused(), "not paused");
        pausedUntil = block.timestamp;
        emit Unpaused(msg.sender);
    }

    /// Irreversible: removes the pause power for good (planned after the audit). Lifts any active pause.
    function disablePauseForever() external onlyOwner {
        require(!pauseDisabled, "already disabled");
        pauseDisabled = true;
        if (paused()) { pausedUntil = block.timestamp; emit Unpaused(msg.sender); }
        emit PauseDisabledForever(msg.sender);
    }

    modifier onlyOperator(address agent) {
        require(agents[agent].registered && msg.sender == agents[agent].operator, "not operator");
        _;
    }

    modifier onlyOperatorOrOwner(address agent) {
        require(agents[agent].registered, "not registered");
        require(msg.sender == agents[agent].operator || msg.sender == owner(), "not operator");
        _;
    }

    // ---------- Fee engine ----------
    /// Burn `feeBurnBps` of `amount` from `from`, send the rest to treasury.
    function _takeFee(address from, uint256 amount) internal {
        if (amount == 0) return;
        uint256 burnPart = (amount * feeBurnBps) / BPS;
        uint256 treasuryPart = amount - burnPart;
        if (burnPart > 0) { _burn(from, burnPart); totalBurned += burnPart; }
        if (treasuryPart > 0) { _transfer(from, treasury, treasuryPart); totalTreasuryFees += treasuryPart; }
        emit FeeTaken(from, burnPart, treasuryPart);
    }

    /// Pay for bot access. `agent` = which bot, `plan` = off-chain plan id (e.g. keccak("monthly")).
    /// The backend unlocks access by reading AccessPaid events. 100% of the payment is a protocol fee.
    function payAccess(address agent, uint256 amount, bytes32 plan) external nonReentrant {
        require(amount > 0, "zero");
        totalAccessPaid += amount;
        _takeFee(msg.sender, amount);
        emit AccessPaid(msg.sender, agent, amount, plan);
    }

    // ---------- Agent lifecycle ----------
    /// Called BY the agent wallet: consent to be registered by `operator` (address(0) withdraws consent).
    function approveOperator(address operator) external {
        approvedOperator[msg.sender] = operator;
        emit OperatorApproved(msg.sender, operator);
    }

    /// Register `agent` with the caller as operator. The agent wallet must have approved the caller
    /// (approveOperator), or be the caller itself. Lifetime slash/anchor history of the wallet is kept.
    function registerAgent(address agent, bytes32 metadataHash, uint256 bond, uint256 dailyLimit)
        external nonReentrant
    {
        require(agent != address(0), "zero agent");
        require(!agents[agent].registered, "already registered");
        require(msg.sender == agent || approvedOperator[agent] == msg.sender, "agent has not approved operator");
        require(bond >= minBond, "bond too low");

        delete approvedOperator[agent];
        _takeFee(msg.sender, registrationFee);
        _transfer(msg.sender, address(this), bond);

        Agent storage a = agents[agent];
        a.operator = msg.sender;
        a.metadataHash = metadataHash;
        a.bond = bond;
        a.dailyLimit = dailyLimit;
        a.spentToday = 0;
        a.windowStart = block.timestamp;
        a.registeredAt = block.timestamp;
        a.unbondRequestedAt = 0;
        a.frozen = false;
        a.registered = true;
        agentCount += 1;

        emit AgentRegistered(agent, msg.sender, bond, dailyLimit);
    }

    function increaseBond(address agent, uint256 amount) external nonReentrant {
        require(agents[agent].registered, "not registered");
        require(amount > 0, "zero");
        _transfer(msg.sender, address(this), amount);
        agents[agent].bond += amount;
        emit BondIncreased(agent, amount);
    }

    /// Only the operator sets the cap; the owner has no say over an agent's spending.
    function setDailyLimit(address agent, uint256 limit) external onlyOperator(agent) {
        agents[agent].dailyLimit = limit;
        emit DailyLimitUpdated(agent, limit);
    }

    /// Kill switch — operator or owner (emergency) can freeze; unfreeze only by operator.
    function freezeAgent(address agent) external onlyOperatorOrOwner(agent) {
        agents[agent].frozen = true;
        emit AgentFrozen(agent, true);
    }

    function unfreezeAgent(address agent) external onlyOperator(agent) {
        agents[agent].frozen = false;
        emit AgentFrozen(agent, false);
    }

    /// Slash bond — tokens are burned. Arbiter should become a multisig/DAO.
    function slash(address agent, uint256 amount, string calldata reason) external {
        require(msg.sender == arbiter, "not arbiter");
        Agent storage a = agents[agent];
        require(a.registered, "not registered");
        if (amount > a.bond) amount = a.bond;
        require(amount > 0, "nothing to slash");
        a.bond -= amount;
        a.slashCount += 1;
        _burn(address(this), amount);
        totalBurned += amount;
        emit AgentSlashed(agent, amount, reason);
    }

    /// Starts the dispute window. From now on the agent can no longer anchor trades.
    function requestUnbond(address agent) external onlyOperator(agent) {
        Agent storage a = agents[agent];
        require(a.unbondRequestedAt == 0, "already requested");
        a.unbondRequestedAt = block.timestamp;
        emit UnbondRequested(agent);
    }

    function cancelUnbond(address agent) external onlyOperator(agent) {
        require(agents[agent].unbondRequestedAt != 0, "not requested");
        agents[agent].unbondRequestedAt = 0;
        emit UnbondCancelled(agent);
    }

    /// After the delay (dispute window), operator gets remaining bond back.
    /// Lifetime slash and anchor counts stay attached to the agent wallet.
    function deregisterAgent(address agent) external nonReentrant onlyOperator(agent) {
        Agent storage a = agents[agent];
        require(a.unbondRequestedAt != 0 && block.timestamp >= a.unbondRequestedAt + UNBOND_DELAY, "unbond delay");
        uint256 refund = a.bond;
        uint256 slashes = a.slashCount;
        uint256 anchors = a.anchorCount;
        delete agents[agent];
        agents[agent].slashCount = slashes;
        agents[agent].anchorCount = anchors;
        agentCount -= 1;
        if (refund > 0) _transfer(address(this), msg.sender, refund);
        emit AgentDeregistered(agent, refund);
    }

    // ---------- Proof of performance ----------
    /// Agent (or its operator) anchors a hash of one trade record. Append-only hash chain:
    /// anchorHead' = keccak256(anchorHead, logHash). Seq numbers never restart, so gaps and
    /// reordering are detectable by replaying TradeAnchored events against the published log.
    function anchorTrade(address agent, bytes32 logHash) external {
        Agent storage a = agents[agent];
        require(a.registered, "not registered");
        require(msg.sender == agent || msg.sender == a.operator, "not agent");
        require(!a.frozen, "agent frozen");
        require(a.unbondRequestedAt == 0, "unbonding");
        a.anchorCount += 1;
        totalAnchors += 1;
        anchorHead[agent] = keccak256(abi.encodePacked(anchorHead[agent], logHash));
        emit TradeAnchored(agent, a.anchorCount, logHash, block.timestamp);
    }

    // ---------- Reputation (simple, on-chain readable) ----------
    /// Score = min(bond / 100 ATB, 100) + days registered + lifetime anchors / 10
    ///         - 100 per lifetime slash. Never below zero. Bond alone cannot buy more than 100 points.
    function reputation(address agent) external view returns (uint256) {
        Agent storage a = agents[agent];
        if (!a.registered) return 0;
        uint256 bondPoints = a.bond / REP_BOND_UNIT;
        if (bondPoints > REP_MAX_BOND_POINTS) bondPoints = REP_MAX_BOND_POINTS;
        uint256 score = bondPoints + (block.timestamp - a.registeredAt) / 1 days + a.anchorCount / 10;
        uint256 penalty = a.slashCount * REP_SLASH_PENALTY;
        return score > penalty ? score - penalty : 0;
    }

    function remainingDailyAllowance(address agent) external view returns (uint256) {
        Agent storage a = agents[agent];
        if (!a.registered || a.dailyLimit == 0) return type(uint256).max;
        if (block.timestamp >= a.windowStart + WINDOW) return a.dailyLimit;
        return a.dailyLimit > a.spentToday ? a.dailyLimit - a.spentToday : 0;
    }

    // ---------- Bounties ----------
    function postBounty(uint256 amount, bytes32 scopeHash) external nonReentrant returns (uint256 id) {
        require(amount > 0, "zero");
        _transfer(msg.sender, address(this), amount);
        bounties.push(Bounty({poster: msg.sender, amount: amount, scopeHash: scopeHash, open: true}));
        id = bounties.length - 1;
        emit BountyPosted(id, msg.sender, amount);
    }

    /// Pay a hunter. A protocol fee (<= 5%) is taken from the payout and split burn / treasury.
    /// The arbiter may also pay out (dispute resolution when the poster refuses to pay).
    function payBounty(uint256 id, address hunter) external nonReentrant {
        Bounty storage b = bounties[id];
        require(b.open, "closed");
        require(msg.sender == b.poster || msg.sender == arbiter, "not allowed");
        require(hunter != address(0), "zero hunter");
        b.open = false;
        uint256 fee = (b.amount * bountyFeeBps) / BPS;
        uint256 payout = b.amount - fee;
        _takeFee(address(this), fee);
        _transfer(address(this), hunter, payout);
        emit BountyPaid(id, hunter, payout, fee);
    }

    function cancelBounty(uint256 id) external nonReentrant {
        Bounty storage b = bounties[id];
        require(b.open && msg.sender == b.poster, "not allowed");
        b.open = false;
        _transfer(address(this), b.poster, b.amount);
        emit BountyCancelled(id);
    }

    function bountyCount() external view returns (uint256) { return bounties.length; }

    // ---------- Transfer hook: enforce agent rules ----------
    function _update(address from, address to, uint256 value) internal override {
        require(!paused(), "paused");

        if (from != address(0) && from != address(this)) {
            Agent storage a = agents[from];
            if (a.registered) {
                require(!a.frozen, "agent frozen");
                if (a.dailyLimit > 0) {
                    if (block.timestamp >= a.windowStart + WINDOW) {
                        a.windowStart = block.timestamp;
                        a.spentToday = 0;
                    }
                    require(a.spentToday + value <= a.dailyLimit, "daily limit exceeded");
                    a.spentToday += value;
                }
            }
        }
        super._update(from, to, value);
    }
}
