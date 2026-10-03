const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("AITradeBot", function () {
  let atb, owner, operator, agent, hunter, stranger, treasury, pool;
  const E = (n) => ethers.parseUnits(String(n), 18);
  const FEE = E(100); // default registration fee
  const DAY = 24 * 3600;

  beforeEach(async () => {
    [owner, operator, agent, hunter, stranger, treasury, pool] = await ethers.getSigners();
    const F = await ethers.getContractFactory("AITradeBot");
    atb = await F.deploy(E(1_000_000_000), owner.address, treasury.address);
    await atb.transfer(operator.address, E(100_000));
    await atb.transfer(agent.address, E(10_000));
    await atb.transfer(stranger.address, E(10_000));
    await atb.transfer(pool.address, E(50_000));
  });

  async function register(limit = E(1_000), bond = E(5_000)) {
    await atb.connect(agent).approveOperator(operator.address);
    await atb.connect(operator).registerAgent(agent.address, ethers.id("meta"), bond, limit);
  }

  // ---------- supply guarantees ----------
  it("has fixed supply, name and symbol", async () => {
    expect(await atb.name()).to.equal("AI Trade Bot");
    expect(await atb.symbol()).to.equal("ATB");
    expect(await atb.totalSupply()).to.equal(E(1_000_000_000));
    expect(atb.mint).to.be.undefined;
  });

  // ---------- agent lifecycle ----------
  it("registers agent, locks bond and takes registration fee (50% burn / 50% treasury)", async () => {
    const supplyBefore = await atb.totalSupply();
    await register();
    const a = await atb.agents(agent.address);
    expect(a.registered).to.be.true;
    expect(a.operator).to.equal(operator.address);
    expect(a.bond).to.equal(E(5_000));
    expect(await atb.balanceOf(operator.address)).to.equal(E(100_000) - E(5_000) - FEE);
    expect(await atb.balanceOf(treasury.address)).to.equal(E(50));
    expect(await atb.totalSupply()).to.equal(supplyBefore - E(50));
    expect(await atb.totalBurned()).to.equal(E(50));
    expect(await atb.totalTreasuryFees()).to.equal(E(50));
    expect(await atb.approvedOperator(agent.address)).to.equal(ethers.ZeroAddress); // consent is one-shot
  });

  it("rejects bond below minimum", async () => {
    await atb.connect(agent).approveOperator(operator.address);
    await expect(
      atb.connect(operator).registerAgent(agent.address, ethers.id("m"), E(10), 0)
    ).to.be.revertedWith("bond too low");
  });

  // ---------- consent: no hostile registration ----------
  it("cannot register a wallet without its consent (pool / third-party griefing)", async () => {
    await expect(atb.connect(stranger).registerAgent(pool.address, ethers.id("x"), E(1_000), 1))
      .to.be.revertedWith("agent has not approved operator");
    // consent given to someone else does not help the attacker
    await atb.connect(pool).approveOperator(operator.address);
    await expect(atb.connect(stranger).registerAgent(pool.address, ethers.id("x"), E(1_000), 1))
      .to.be.revertedWith("agent has not approved operator");
    // consent can be withdrawn
    await atb.connect(pool).approveOperator(ethers.ZeroAddress);
    await expect(atb.connect(operator).registerAgent(pool.address, ethers.id("x"), E(1_000), 1))
      .to.be.revertedWith("agent has not approved operator");
    // pool keeps transferring freely
    await atb.connect(pool).transfer(hunter.address, E(1));
  });

  it("a wallet can register itself as its own operator", async () => {
    await atb.connect(agent).registerAgent(agent.address, ethers.id("self"), E(1_000), 0);
    expect((await atb.agents(agent.address)).operator).to.equal(agent.address);
  });

  it("enforces daily spend limit and resets after 24h", async () => {
    await register(E(1_000));
    await atb.connect(agent).transfer(stranger.address, E(600));
    await expect(atb.connect(agent).transfer(stranger.address, E(500)))
      .to.be.revertedWith("daily limit exceeded");
    await time.increase(DAY + 1);
    await atb.connect(agent).transfer(stranger.address, E(900));
    expect(await atb.remainingDailyAllowance(agent.address)).to.equal(E(100));
  });

  it("only the operator can change the daily limit (not owner, not stranger)", async () => {
    await register(E(1_000));
    await expect(atb.connect(owner).setDailyLimit(agent.address, 1)).to.be.revertedWith("not operator");
    await expect(atb.connect(stranger).setDailyLimit(agent.address, 1)).to.be.revertedWith("not operator");
    await atb.connect(operator).setDailyLimit(agent.address, E(2_000));
    expect((await atb.agents(agent.address)).dailyLimit).to.equal(E(2_000));
  });

  it("kill switch blocks transfers; only operator can unfreeze", async () => {
    await register(0);
    await atb.connect(owner).freezeAgent(agent.address);
    await expect(atb.connect(agent).transfer(stranger.address, E(1)))
      .to.be.revertedWith("agent frozen");
    await expect(atb.connect(owner).unfreezeAgent(agent.address))
      .to.be.revertedWith("not operator");
    await expect(atb.connect(stranger).freezeAgent(agent.address))
      .to.be.revertedWith("not operator");
    await atb.connect(operator).unfreezeAgent(agent.address);
    await atb.connect(agent).transfer(stranger.address, E(1));
  });

  it("owner cannot freeze an unregistered wallet", async () => {
    await expect(atb.connect(owner).freezeAgent(pool.address)).to.be.revertedWith("not registered");
  });

  it("arbiter slashes bond and burns it", async () => {
    await register();
    const before = await atb.totalSupply();
    await expect(atb.connect(owner).slash(agent.address, E(2_000), "leaked keys"))
      .to.emit(atb, "AgentSlashed");
    const a = await atb.agents(agent.address);
    expect(a.bond).to.equal(E(3_000));
    expect(a.slashCount).to.equal(1);
    expect(await atb.totalSupply()).to.equal(before - E(2_000));
    await expect(atb.connect(stranger).slash(agent.address, E(1), "x"))
      .to.be.revertedWith("not arbiter");
    await expect(atb.connect(owner).slash(agent.address, 0, "x"))
      .to.be.revertedWith("nothing to slash");
  });

  it("deregister returns bond only after delay", async () => {
    await register();
    await atb.connect(operator).requestUnbond(agent.address);
    await expect(atb.connect(operator).deregisterAgent(agent.address))
      .to.be.revertedWith("unbond delay");
    await time.increase(7 * DAY + 1);
    await expect(atb.connect(stranger).deregisterAgent(agent.address)).to.be.revertedWith("not operator");
    await atb.connect(operator).deregisterAgent(agent.address);
    expect(await atb.balanceOf(operator.address)).to.equal(E(100_000) - FEE);
    expect(await atb.agentCount()).to.equal(0);
  });

  it("unbonding stops anchoring, so the dispute window always follows the last activity", async () => {
    await register();
    await atb.connect(operator).requestUnbond(agent.address);
    await expect(atb.connect(agent).anchorTrade(agent.address, ethers.id("t"))).to.be.revertedWith("unbonding");
    await expect(atb.connect(operator).requestUnbond(agent.address)).to.be.revertedWith("already requested");
    await expect(atb.connect(owner).requestUnbond(agent.address)).to.be.revertedWith("not operator");
    // cancel resumes operation; a new request restarts the full window
    await time.increase(6 * DAY);
    await atb.connect(operator).cancelUnbond(agent.address);
    await atb.connect(agent).anchorTrade(agent.address, ethers.id("t"));
    await atb.connect(operator).requestUnbond(agent.address);
    await time.increase(2 * DAY);
    await expect(atb.connect(operator).deregisterAgent(agent.address)).to.be.revertedWith("unbond delay");
  });

  it("slash and anchor history survive deregistration and re-registration", async () => {
    await register();
    await atb.connect(agent).anchorTrade(agent.address, ethers.id("t1"));
    await atb.connect(agent).anchorTrade(agent.address, ethers.id("t2"));
    await atb.slash(agent.address, E(10), "bad");
    await atb.connect(operator).requestUnbond(agent.address);
    await time.increase(7 * DAY + 1);
    await atb.connect(operator).deregisterAgent(agent.address);
    let a = await atb.agents(agent.address);
    expect(a.registered).to.be.false;
    expect(a.slashCount).to.equal(1);
    expect(a.anchorCount).to.equal(2);

    await register();
    a = await atb.agents(agent.address);
    expect(a.slashCount).to.equal(1);
    expect(a.unbondRequestedAt).to.equal(0);
    await expect(atb.connect(agent).anchorTrade(agent.address, ethers.id("t3")))
      .to.emit(atb, "TradeAnchored").withArgs(agent.address, 3, ethers.id("t3"), (t) => t > 0n);
  });

  // ---------- proof of performance ----------
  it("anchors trade hashes into a hash chain and counts them into reputation", async () => {
    await register();
    let head = ethers.ZeroHash;
    for (let i = 0; i < 10; i++) {
      const h = ethers.id("trade" + i);
      await expect(atb.connect(agent).anchorTrade(agent.address, h)).to.emit(atb, "TradeAnchored");
      head = ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [head, h]);
    }
    expect(await atb.anchorHead(agent.address)).to.equal(head);
    expect((await atb.agents(agent.address)).anchorCount).to.equal(10);
    expect(await atb.totalAnchors()).to.equal(10);
    expect(await atb.agentCount()).to.equal(1);
    expect(await atb.reputation(agent.address)).to.equal(51n); // 50 bond points + 10/10 anchors
    await expect(atb.connect(stranger).anchorTrade(agent.address, ethers.id("x")))
      .to.be.revertedWith("not agent");
    await atb.connect(operator).freezeAgent(agent.address);
    await expect(atb.connect(agent).anchorTrade(agent.address, ethers.id("x")))
      .to.be.revertedWith("agent frozen");
  });

  it("reputation: bond points are capped, days count, slashes subtract", async () => {
    await register(E(1_000), E(50_000));
    expect(await atb.reputation(agent.address)).to.equal(100n); // capped at 100 bond points
    await time.increase(30 * DAY);
    expect(await atb.reputation(agent.address)).to.equal(130n);
    await atb.slash(agent.address, E(1_000), "r");
    expect(await atb.reputation(agent.address)).to.equal(30n);
    await atb.slash(agent.address, E(1_000), "r");
    expect(await atb.reputation(agent.address)).to.equal(0n);
  });

  // ---------- fee engine ----------
  it("payAccess splits burn / treasury and emits AccessPaid", async () => {
    const supplyBefore = await atb.totalSupply();
    await expect(atb.connect(operator).payAccess(agent.address, E(1_000), ethers.id("monthly")))
      .to.emit(atb, "AccessPaid").withArgs(operator.address, agent.address, E(1_000), ethers.id("monthly"));
    expect(await atb.totalSupply()).to.equal(supplyBefore - E(500));
    expect(await atb.balanceOf(treasury.address)).to.equal(E(500));
    expect(await atb.totalAccessPaid()).to.equal(E(1_000));
  });

  it("fee params are bounded by hard caps", async () => {
    await expect(atb.setFeeParams(2_999, 200, E(100), E(1_000))).to.be.revertedWith("burn share out of range");
    await expect(atb.setFeeParams(5_000, 501, E(100), E(1_000))).to.be.revertedWith("bounty fee too high");
    await expect(atb.setFeeParams(5_000, 200, E(1_001), E(1_000))).to.be.revertedWith("registration fee too high");
    await expect(atb.setFeeParams(5_000, 200, E(100), E(100_001))).to.be.revertedWith("min bond too high");
    await expect(atb.connect(stranger).setFeeParams(5_000, 200, E(100), E(1_000))).to.be.reverted;
    await atb.setFeeParams(10_000, 0, 0, E(500)); // 100% burn, no fees, lower bond
    await atb.connect(operator).payAccess(agent.address, E(100), ethers.id("p"));
    expect(await atb.balanceOf(treasury.address)).to.equal(0);
    expect(await atb.totalBurned()).to.equal(E(100));
  });

  // ---------- bounties ----------
  it("bounty escrow: post, pay (2% fee), cancel", async () => {
    await atb.connect(operator).postBounty(E(1_000), ethers.id("scope"));
    await expect(atb.connect(stranger).payBounty(0, stranger.address)).to.be.revertedWith("not allowed");
    await expect(atb.connect(operator).payBounty(0, hunter.address))
      .to.emit(atb, "BountyPaid").withArgs(0, hunter.address, E(980), E(20));
    expect(await atb.balanceOf(hunter.address)).to.equal(E(980));
    expect(await atb.balanceOf(treasury.address)).to.equal(E(10));
    await expect(atb.connect(operator).payBounty(0, hunter.address)).to.be.revertedWith("closed");
    await atb.connect(operator).postBounty(E(500), ethers.id("scope2"));
    await expect(atb.connect(stranger).cancelBounty(1)).to.be.revertedWith("not allowed");
    await atb.connect(operator).cancelBounty(1);
    expect(await atb.balanceOf(operator.address)).to.equal(E(99_000));
  });

  // ---------- bounded pause ----------
  it("pause blocks all transfers and unpause lifts it", async () => {
    await atb.pause();
    await expect(atb.transfer(stranger.address, E(1))).to.be.revertedWith("paused");
    await expect(atb.connect(stranger).pause()).to.be.reverted;
    await atb.unpause();
    await atb.transfer(stranger.address, E(1));
  });

  it("pause expires on its own and has a cooldown", async () => {
    await atb.pause();
    await time.increase(7 * DAY + 1);
    expect(await atb.paused()).to.be.false;
    await atb.transfer(stranger.address, E(1));
    await expect(atb.pause()).to.be.revertedWith("pause cooldown");
    await time.increase(7 * DAY);
    await atb.pause();
    expect(await atb.paused()).to.be.true;
  });

  it("pause can be disabled forever, lifting any active pause", async () => {
    await atb.pause();
    await atb.disablePauseForever();
    expect(await atb.paused()).to.be.false;
    expect(await atb.pauseDisabled()).to.be.true;
    await time.increase(30 * DAY);
    await expect(atb.pause()).to.be.revertedWith("pause disabled");
    // other admin functions keep working
    await atb.setFeeParams(6_000, 200, E(100), E(1_000));
  });

  // ---------- ownership ----------
  it("ownership transfer is two-step", async () => {
    await atb.transferOwnership(stranger.address);
    expect(await atb.owner()).to.equal(owner.address);
    expect(await atb.pendingOwner()).to.equal(stranger.address);
    await expect(atb.connect(hunter).acceptOwnership()).to.be.reverted;
    await atb.connect(stranger).acceptOwnership();
    expect(await atb.owner()).to.equal(stranger.address);
  });
});

describe("TokenVesting", function () {
  let atb, vest, owner, team, stranger, treasury;
  const E = (n) => ethers.parseUnits(String(n), 18);
  const MONTH = 30 * 24 * 3600;

  beforeEach(async () => {
    [owner, team, stranger, treasury] = await ethers.getSigners();
    const F = await ethers.getContractFactory("AITradeBot");
    atb = await F.deploy(E(1_000_000_000), owner.address, treasury.address);
    const V = await ethers.getContractFactory("TokenVesting");
    vest = await V.deploy(await atb.getAddress(), owner.address);
    await atb.approve(await vest.getAddress(), E(150_000_000));
  });

  it("creates a funded schedule and pulls tokens", async () => {
    const start = await time.latest();
    await expect(vest.createSchedule(team.address, E(150_000_000), start, 12 * MONTH, 48 * MONTH, "Team"))
      .to.emit(vest, "ScheduleCreated");
    expect(await atb.balanceOf(await vest.getAddress())).to.equal(E(150_000_000));
    expect(await vest.totalLocked()).to.equal(E(150_000_000));
    await expect(vest.connect(stranger).createSchedule(stranger.address, E(1), start, 0, 1, "x")).to.be.reverted;
  });

  it("supports several schedules for one beneficiary (treasury multisig) and releases them together", async () => {
    const start = await time.latest();
    await atb.approve(await vest.getAddress(), E(600_000_000));
    await vest.createSchedule(team.address, E(300_000_000), start, 0, 36 * MONTH, "Community & Bounty");
    await vest.createSchedule(team.address, E(150_000_000), start, 6 * MONTH, 30 * MONTH, "Ecosystem");
    await vest.createSchedule(team.address, E(150_000_000), start, 6 * MONTH, 30 * MONTH, "Foundation");
    expect(await vest.scheduleCountOf(team.address)).to.equal(3);
    expect(await vest.beneficiaryCount()).to.equal(1);
    expect(await vest.scheduleCount()).to.equal(3);

    await time.increaseTo(start + 3 * MONTH); // only community has started
    expect(await vest.releasable(team.address)).to.be.closeTo(E(25_000_000), E(100));

    await time.increaseTo(start + 6 * MONTH); // cliffs pass: 50M + 30M + 30M
    await vest.release(team.address);
    expect(await atb.balanceOf(team.address)).to.be.closeTo(E(110_000_000), E(100));
    expect(await vest.totalLocked()).to.be.closeTo(E(490_000_000), E(100));
  });

  it("releases nothing before cliff, linearly after, all at end", async () => {
    const start = await time.latest();
    await vest.createSchedule(team.address, E(150_000_000), start, 12 * MONTH, 48 * MONTH, "Team");

    await time.increase(11 * MONTH);
    expect(await vest.releasable(team.address)).to.equal(0);
    await expect(vest.release(team.address)).to.be.revertedWith("nothing to release");

    await time.increaseTo(start + 24 * MONTH); // halfway through duration
    const half = await vest.releasable(team.address);
    expect(half).to.be.closeTo(E(75_000_000), E(100));
    await vest.connect(stranger).release(team.address); // anyone can trigger, tokens go to team
    expect(await atb.balanceOf(team.address)).to.be.closeTo(E(75_000_000), E(100));

    await time.increaseTo(start + 48 * MONTH + 1);
    await vest.release(team.address);
    expect(await atb.balanceOf(team.address)).to.equal(E(150_000_000));
    expect(await vest.totalLocked()).to.equal(0);
  });

  it("has no revoke or withdraw path", async () => {
    expect(vest.revoke).to.be.undefined;
    expect(vest.withdraw).to.be.undefined;
    expect(vest.emergencyWithdraw).to.be.undefined;
  });

  it("owner renounce freezes schedule creation", async () => {
    await vest.renounceOwnership();
    const start = await time.latest();
    await expect(vest.createSchedule(team.address, E(1), start, 0, 1, "x")).to.be.reverted;
  });
});
