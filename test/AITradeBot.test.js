const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("AITradeBot", function () {
  let atb, owner, operator, agent, hunter, stranger, treasury;
  const E = (n) => ethers.parseUnits(String(n), 18);
  const FEE = E(100); // default registration fee

  beforeEach(async () => {
    [owner, operator, agent, hunter, stranger, treasury] = await ethers.getSigners();
    const F = await ethers.getContractFactory("AITradeBot");
    atb = await F.deploy(E(1_000_000_000), owner.address, treasury.address);
    await atb.transfer(operator.address, E(100_000));
    await atb.transfer(agent.address, E(10_000));
  });

  async function register(limit = E(1_000)) {
    await atb.connect(operator).registerAgent(agent.address, ethers.id("meta"), E(5_000), limit);
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
    expect(a.bond).to.equal(E(5_000));
    expect(await atb.balanceOf(operator.address)).to.equal(E(100_000) - E(5_000) - FEE);
    expect(await atb.balanceOf(treasury.address)).to.equal(E(50));
    expect(await atb.totalSupply()).to.equal(supplyBefore - E(50));
    expect(await atb.totalBurned()).to.equal(E(50));
    expect(await atb.totalTreasuryFees()).to.equal(E(50));
  });

  it("rejects bond below minimum", async () => {
    await expect(
      atb.connect(operator).registerAgent(agent.address, ethers.id("m"), E(10), 0)
    ).to.be.revertedWith("bond too low");
  });

  it("enforces daily spend limit and resets after 24h", async () => {
    await register(E(1_000));
    await atb.connect(agent).transfer(stranger.address, E(600));
    await expect(atb.connect(agent).transfer(stranger.address, E(500)))
      .to.be.revertedWith("daily limit exceeded");
    await time.increase(24 * 3600 + 1);
    await atb.connect(agent).transfer(stranger.address, E(900));
    expect(await atb.remainingDailyAllowance(agent.address)).to.equal(E(100));
  });

  it("kill switch blocks transfers; only operator can unfreeze", async () => {
    await register(0);
    await atb.connect(owner).freezeAgent(agent.address);
    await expect(atb.connect(agent).transfer(stranger.address, E(1)))
      .to.be.revertedWith("agent frozen");
    await expect(atb.connect(owner).unfreezeAgent(agent.address))
      .to.be.revertedWith("not operator");
    await atb.connect(operator).unfreezeAgent(agent.address);
    await atb.connect(agent).transfer(stranger.address, E(1));
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
  });

  it("deregister returns bond only after delay", async () => {
    await register();
    await atb.connect(operator).requestUnbond(agent.address);
    await expect(atb.connect(operator).deregisterAgent(agent.address))
      .to.be.revertedWith("unbond delay");
    await time.increase(7 * 24 * 3600 + 1);
    await atb.connect(operator).deregisterAgent(agent.address);
    expect(await atb.balanceOf(operator.address)).to.equal(E(100_000) - FEE);
  });

  // ---------- proof of performance ----------
  it("anchors trade hashes and counts them into reputation", async () => {
    await register();
    for (let i = 0; i < 10; i++) {
      await expect(atb.connect(agent).anchorTrade(agent.address, ethers.id("trade" + i)))
        .to.emit(atb, "TradeAnchored");
    }
    expect((await atb.agents(agent.address)).anchorCount).to.equal(10);
    expect(await atb.totalAnchors()).to.equal(10);
    expect(await atb.agentCount()).to.equal(1);
    expect(await atb.reputation(agent.address)).to.equal(5_001n); // 5000 bond + 10/10 anchors
    await expect(atb.connect(stranger).anchorTrade(agent.address, ethers.id("x")))
      .to.be.revertedWith("not agent");
    await atb.connect(operator).freezeAgent(agent.address);
    await expect(atb.connect(agent).anchorTrade(agent.address, ethers.id("x")))
      .to.be.revertedWith("agent frozen");
  });

  it("reputation reflects bond and slashes", async () => {
    await register();
    expect(await atb.reputation(agent.address)).to.equal(5_000n);
    await atb.slash(agent.address, E(1_000), "r");
    expect(await atb.reputation(agent.address)).to.equal(3_900n);
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
    await expect(atb.connect(stranger).setFeeParams(5_000, 200, E(100), E(1_000))).to.be.reverted;
    await atb.setFeeParams(10_000, 0, 0, E(500)); // 100% burn, no fees, lower bond
    await atb.connect(operator).payAccess(agent.address, E(100), ethers.id("p"));
    expect(await atb.balanceOf(treasury.address)).to.equal(0);
    expect(await atb.totalBurned()).to.equal(E(100));
  });

  // ---------- bounties ----------
  it("bounty escrow: post, pay (2% fee), cancel", async () => {
    await atb.connect(operator).postBounty(E(1_000), ethers.id("scope"));
    await expect(atb.connect(operator).payBounty(0, hunter.address))
      .to.emit(atb, "BountyPaid").withArgs(0, hunter.address, E(980), E(20));
    expect(await atb.balanceOf(hunter.address)).to.equal(E(980));
    expect(await atb.balanceOf(treasury.address)).to.equal(E(10));
    await atb.connect(operator).postBounty(E(500), ethers.id("scope2"));
    await expect(atb.connect(stranger).cancelBounty(1)).to.be.revertedWith("not allowed");
    await atb.connect(operator).cancelBounty(1);
    expect(await atb.balanceOf(operator.address)).to.equal(E(99_000));
  });

  it("pause blocks all transfers", async () => {
    await atb.pause();
    await expect(atb.transfer(stranger.address, E(1))).to.be.revertedWith("paused");
    await atb.unpause();
    await atb.transfer(stranger.address, E(1));
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
});
