// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * TokenVesting — irrevocable linear vesting with cliff. A beneficiary may hold
 * several schedules (e.g. a treasury multisig receiving Community, Ecosystem and
 * Foundation allocations with different curves).
 *
 *  - Tokens are pulled from the creator at schedule creation, so every schedule is
 *    fully funded on-chain from day one (no IOUs).
 *  - There is NO revoke, NO early release and NO admin withdrawal. Once created,
 *    a schedule can only be claimed by its beneficiary as it vests.
 *  - Owner can only create schedules. Renounce ownership after setup to freeze.
 */
contract TokenVesting is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Schedule {
        uint256 total;      // total tokens in this schedule
        uint256 released;   // already claimed
        uint64 start;       // vesting start (TGE)
        uint64 cliff;       // seconds after start before anything vests
        uint64 duration;    // total vesting length from start (>= cliff)
        string label;       // "Team", "Community & Bounty", ... (for explorers)
    }

    IERC20 public immutable token;
    mapping(address => Schedule[]) private _schedules;
    address[] public beneficiaries;   // unique, in creation order
    uint256 public totalLocked;       // sum of (total - released) across all schedules
    uint256 public scheduleCount;     // total schedules created

    event ScheduleCreated(address indexed beneficiary, uint256 indexed index, uint256 total, uint64 start, uint64 cliff, uint64 duration, string label);
    event Released(address indexed beneficiary, uint256 amount);

    constructor(IERC20 token_, address initialOwner) Ownable(initialOwner) {
        require(address(token_) != address(0), "zero token");
        token = token_;
    }

    /// Create a funded schedule. Caller must have approved `total` tokens.
    function createSchedule(
        address beneficiary,
        uint256 total,
        uint64 start,
        uint64 cliff,
        uint64 duration,
        string calldata label
    ) external onlyOwner nonReentrant {
        require(beneficiary != address(0), "zero beneficiary");
        require(total > 0, "zero total");
        require(duration > 0 && cliff <= duration, "bad duration");

        token.safeTransferFrom(msg.sender, address(this), total);
        if (_schedules[beneficiary].length == 0) beneficiaries.push(beneficiary);
        _schedules[beneficiary].push(Schedule(total, 0, start, cliff, duration, label));
        totalLocked += total;
        scheduleCount += 1;
        emit ScheduleCreated(beneficiary, _schedules[beneficiary].length - 1, total, start, cliff, duration, label);
    }

    // ---------- Views ----------
    function schedulesOf(address beneficiary) external view returns (Schedule[] memory) { return _schedules[beneficiary]; }
    function scheduleCountOf(address beneficiary) external view returns (uint256) { return _schedules[beneficiary].length; }
    function beneficiaryCount() external view returns (uint256) { return beneficiaries.length; }

    function _vested(Schedule storage s, uint64 timestamp) internal view returns (uint256) {
        if (timestamp < s.start + s.cliff) return 0;
        uint256 elapsed = timestamp - s.start;
        if (elapsed >= s.duration) return s.total;
        return (s.total * elapsed) / s.duration;
    }

    /// Total vested across all of a beneficiary's schedules at `timestamp`.
    function vestedAmount(address beneficiary, uint64 timestamp) public view returns (uint256 sum) {
        Schedule[] storage list = _schedules[beneficiary];
        for (uint256 i = 0; i < list.length; i++) sum += _vested(list[i], timestamp);
    }

    function releasable(address beneficiary) public view returns (uint256 sum) {
        Schedule[] storage list = _schedules[beneficiary];
        uint64 t = uint64(block.timestamp);
        for (uint256 i = 0; i < list.length; i++) sum += _vested(list[i], t) - list[i].released;
    }

    // ---------- Claim ----------
    /// Anyone may trigger a release; tokens always go to the beneficiary.
    function release(address beneficiary) external nonReentrant {
        Schedule[] storage list = _schedules[beneficiary];
        uint64 t = uint64(block.timestamp);
        uint256 amount;
        for (uint256 i = 0; i < list.length; i++) {
            uint256 due = _vested(list[i], t) - list[i].released;
            if (due > 0) { list[i].released += due; amount += due; }
        }
        require(amount > 0, "nothing to release");
        totalLocked -= amount;
        token.safeTransfer(beneficiary, amount);
        emit Released(beneficiary, amount);
    }
}
