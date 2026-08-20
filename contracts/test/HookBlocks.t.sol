// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {HookBlocks, PoolKey, SwapParams} from "../src/campaign/HookBlocks.sol";

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

contract MockToken {
    string public name;
    uint256 public totalSupply;
    bool public feeOnTransfer;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_) {
        name = name_;
    }

    function mint(address to, uint256 amount) public {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function setFeeOnTransfer(bool v) external {
        feeOnTransfer = v;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        return _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        require(allowance[from][msg.sender] >= value, "allowance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= value;
        }
        return _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) internal returns (bool) {
        require(balanceOf[from] >= value, "balance");
        uint256 credited = feeOnTransfer ? value - value / 100 : value;
        balanceOf[from] -= value;
        balanceOf[to] += credited;
        return true;
    }
}

/// @dev A HOOKR double that re-enters HookBlocks from inside `transfer`,
///      i.e. from the burn call the buy-and-burn change introduced.
contract MockReentrantHookr is MockToken {
    address public target;
    uint8 public mode; // 1 = buyAndBurn, 2 = sweepUnspent, 3 = unlockCallback

    constructor() MockToken("HOOKR") {}

    function arm(address target_, uint8 mode_) external {
        target = target_;
        mode = mode_;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (target != address(0)) {
            address t = target;
            uint8 m = mode;
            target = address(0); // one shot, so the mock cannot loop forever
            if (m == 1) HookBlocks(payable(t)).buyAndBurn(0);
            else if (m == 2) HookBlocks(payable(t)).sweepUnspent();
            else if (m == 3) HookBlocks(payable(t)).unlockCallback(abi.encode(uint256(1)));
        }
        return super.transfer(to, value);
    }
}

contract MockWeth is MockToken {
    constructor() MockToken("WETH") {}

    receive() external payable {}

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "native send");
    }
}

/// @dev Fee-share vault double: settable claimable, mintable shares, and a
///      revert switch to prove the bond path degrades instead of bricking.
contract MockVault is MockToken {
    MockWeth public immutable weth;
    mapping(address => uint256) public pendingClaim;
    bool public reverts;
    address public reenterTarget;

    constructor(MockWeth weth_) MockToken("Mock fee shares") {
        weth = weth_;
    }

    function setClaimable(address account, uint256 amount) external {
        pendingClaim[account] = amount;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function setReenter(address target) external {
        reenterTarget = target;
    }

    function rewardAssetCount() external pure returns (uint256) {
        return 1;
    }

    function rewardAssets(uint256 index) external view returns (address) {
        require(index == 0, "index");
        return address(weth);
    }

    function claimable(address account, address) external view returns (uint256) {
        require(!reverts, "vault paused");
        return pendingClaim[account];
    }

    function claimFor(address account) external {
        require(!reverts, "vault paused");
        if (reenterTarget != address(0)) {
            HookBlocks(payable(reenterTarget)).buyAndBurn(0);
        }
        uint256 amount = pendingClaim[account];
        pendingClaim[account] = 0;
        weth.mint(account, amount);
    }
}

/// @dev A vault whose reward-asset introspection disagrees with WETH, for
///      constructor fail-closed coverage.
contract MockWrongAssetVault is MockToken {
    address public immutable other;

    constructor(address other_) MockToken("wrong vault") {
        other = other_;
    }

    function rewardAssetCount() external pure returns (uint256) {
        return 1;
    }

    function rewardAssets(uint256) external view returns (address) {
        return other;
    }
}

/// @dev v4-core PoolManager double for the one pinned pool: quotes spot via
///      `extsload`, executes swaps at an independently settable rate (so
///      tests can push execution away from the quoted spot), enforces
///      take/settle bookkeeping, and can misbehave on demand.
contract MockPoolManager {
    MockToken public immutable hookr;

    uint160 public sqrtPriceX96Word;
    uint256 public execRateHookrPerEth1e18;
    uint256 public consumeCap = type(uint256).max;
    bool public shortPayTake;
    bool public skipCallback;
    uint256 public overMintWei;
    address public reenterTarget;

    bool private _unlocked;
    uint256 private _pendingOwed;
    uint256 private _pendingOut;

    constructor(MockToken hookr_) {
        hookr = hookr_;
    }

    receive() external payable {}

    /// @notice Sets BOTH the quoted spot and the executed rate to `rate`.
    function setRate(uint256 rateHookrPerEth1e18) external {
        setSpotRate(rateHookrPerEth1e18);
        execRateHookrPerEth1e18 = rateHookrPerEth1e18;
    }

    /// @notice Sets only the quoted spot (what `extsload` reports).
    function setSpotRate(uint256 rateHookrPerEth1e18) public {
        // priceX96 = rate * 2^96 / 1e18 and sqrtP = sqrt(priceX96 << 96).
        uint256 priceX96 = (rateHookrPerEth1e18 * (uint256(1) << 96)) / 1e18;
        sqrtPriceX96Word = uint160(_sqrt(priceX96 << 96));
    }

    /// @notice Sets only the executed rate (what `swap` actually pays).
    function setExecRate(uint256 rateHookrPerEth1e18) external {
        execRateHookrPerEth1e18 = rateHookrPerEth1e18;
    }

    function setConsumeCap(uint256 cap) external {
        consumeCap = cap;
    }

    function setShortPayTake(bool v) external {
        shortPayTake = v;
    }

    function setOverMintWei(uint256 v) external {
        overMintWei = v;
    }

    function setSkipCallback(bool v) external {
        skipCallback = v;
    }

    function setReenterOnTake(address target) external {
        reenterTarget = target;
    }

    function setRawSqrtPrice(uint160 v) external {
        sqrtPriceX96Word = v;
    }

    function extsload(bytes32) external view returns (bytes32) {
        return bytes32(uint256(sqrtPriceX96Word));
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!_unlocked, "locked");
        _unlocked = true;
        if (!skipCallback) {
            result = IUnlockCallback(msg.sender).unlockCallback(data);
        }
        require(_pendingOwed == 0 && _pendingOut == 0, "unsettled");
        _unlocked = false;
    }

    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata) external returns (int256) {
        require(_unlocked, "not unlocked");
        require(key.currency0 == address(0) && key.currency1 == address(hookr), "key");
        require(params.zeroForOne && params.amountSpecified < 0, "params");
        uint256 ethIn = uint256(-params.amountSpecified);
        uint256 consumed = ethIn > consumeCap ? consumeCap : ethIn;
        uint256 out = (consumed * execRateHookrPerEth1e18) / 1e18;
        _pendingOwed = consumed;
        _pendingOut = out;
        // BalanceDelta packing: amount0 in the high 128 bits, amount1 low.
        return (int256(-int256(consumed)) << 128) | int256(uint256(uint128(out)));
    }

    function take(address currency, address to, uint256 amount) external {
        require(_unlocked, "not unlocked");
        require(currency == address(hookr), "currency");
        require(amount <= _pendingOut, "over-take");
        _pendingOut -= amount;
        if (reenterTarget != address(0)) {
            HookBlocks(payable(reenterTarget)).buyAndBurn(0);
        }
        hookr.mint(to, shortPayTake ? amount / 2 : amount + overMintWei);
    }

    function settle() external payable returns (uint256) {
        require(_unlocked, "not unlocked");
        require(msg.value == _pendingOwed, "settle amount");
        _pendingOwed = 0;
        return msg.value;
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}

contract HookBlocksTest is Test {
    uint256 internal constant CHAIN = 4663;
    uint16 internal constant MIN_OUT_BPS = 9_700;
    uint256 internal constant MAX_BUY = 0.05 ether;
    uint256 internal constant MIN_BUY = 0.0005 ether;
    uint24 internal constant FEE = 2500;
    int24 internal constant SPACING = 25;

    MockWeth internal weth;
    MockToken internal hookr;
    MockVault internal vault;
    MockPoolManager internal pm;
    HookBlocks internal hb;

    address internal sponsor = makeAddr("sponsor");
    address internal keeper = makeAddr("keeper");

    uint64 internal startAt;
    uint64 internal endAt;
    uint64 internal sweepAfter;

    /// @dev HOOKR already at DEAD before this campaign starts. On chain 4663
    ///      0x…dEaD is a shared sink anyone may send to, so every assertion
    ///      here must use the DELTA over the campaign's own transactions —
    ///      seeding this non-zero is what makes a wrong assertion fail.
    uint256 internal constant DEAD_PRESEED = 12_345e18;

    function setUp() public {
        vm.chainId(CHAIN);
        weth = new MockWeth();
        hookr = new MockToken("HOOKR");
        hookr.mint(0x000000000000000000000000000000000000dEaD, DEAD_PRESEED);
        vault = new MockVault(weth);
        pm = new MockPoolManager(hookr);
        pm.setRate(3_500_000e18); // ~ the live pool's magnitude
        vm.deal(address(weth), 1_000 ether); // native reserve backing unwraps

        startAt = uint64(block.timestamp + 1 days);
        endAt = startAt + 14 days;
        sweepAfter = endAt + 30 days;

        hb = _deploy(address(vault), address(weth), address(hookr), address(pm));

        vault.mint(sponsor, 50e18);
        vm.prank(sponsor);
        vault.approve(address(hb), type(uint256).max);
    }

    function _deploy(address vault_, address weth_, address hookr_, address pm_) internal returns (HookBlocks) {
        return new HookBlocks(
            vault_,
            weth_,
            hookr_,
            pm_,
            FEE,
            SPACING,
            _poolId(hookr_),
            sponsor,
            startAt,
            endAt,
            sweepAfter,
            MIN_OUT_BPS,
            MAX_BUY,
            MIN_BUY
        );
    }

    function _poolId(address hookr_) internal pure returns (bytes32) {
        return keccak256(abi.encode(address(0), hookr_, FEE, SPACING, address(0)));
    }

    function _fund() internal {
        vm.prank(sponsor);
        hb.fundFeeShares(50e18);
    }

    /// @dev The floor exactly as the contract derives it: from the pool's
    ///      stored sqrt word, not from the ideal rate (integer sqrt in the
    ///      mock truncates, and the contract's number is the binding one).
    function _floor(uint256 ethIn) internal view returns (uint256) {
        uint256 sqrtP = pm.sqrtPriceX96Word();
        uint256 priceX96 = (sqrtP * sqrtP) >> 96;
        return (((ethIn * priceX96) >> 96) * MIN_OUT_BPS) / 10_000;
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_pinsIdentityAndVerifiesPool() public view {
        assertEq(hb.FEE_SHARES(), address(vault));
        assertEq(hb.WETH(), address(weth));
        assertEq(hb.HOOKR(), address(hookr));
        assertEq(address(hb.POOL_MANAGER()), address(pm));
        assertEq(hb.POOL_ID(), _poolId(address(hookr)));
        assertEq(hb.SPONSOR(), sponsor);
        assertEq(hb.START_AT(), startAt);
        assertEq(hb.END_AT(), endAt);
        assertEq(hb.SWEEP_AFTER(), sweepAfter);
        PoolKey memory key = hb.poolKey();
        assertEq(key.currency0, address(0));
        assertEq(key.currency1, address(hookr));
        assertEq(key.hooks, address(0));
    }

    function test_constructor_rejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(HookBlocks.WrongChain.selector, 1));
        _deploy(address(vault), address(weth), address(hookr), address(pm));
        vm.chainId(CHAIN);
    }

    function test_constructor_rejectsZeroAndCodelessAddresses() public {
        vm.expectRevert(HookBlocks.ZeroAddress.selector);
        _deploy(address(0), address(weth), address(hookr), address(pm));
        vm.expectRevert(abi.encodeWithSelector(HookBlocks.NoCode.selector, makeAddr("eoa")));
        _deploy(makeAddr("eoa"), address(weth), address(hookr), address(pm));
    }

    function test_constructor_rejectsBadSchedule() public {
        vm.expectRevert(HookBlocks.InvalidSchedule.selector);
        new HookBlocks(
            address(vault),
            address(weth),
            address(hookr),
            address(pm),
            FEE,
            SPACING,
            _poolId(address(hookr)),
            sponsor,
            uint64(block.timestamp), // startAt not in the future
            endAt,
            sweepAfter,
            MIN_OUT_BPS,
            MAX_BUY,
            MIN_BUY
        );
        vm.expectRevert(HookBlocks.InvalidSchedule.selector);
        new HookBlocks(
            address(vault),
            address(weth),
            address(hookr),
            address(pm),
            FEE,
            SPACING,
            _poolId(address(hookr)),
            sponsor,
            startAt,
            startAt, // end == start
            sweepAfter,
            MIN_OUT_BPS,
            MAX_BUY,
            MIN_BUY
        );
        vm.expectRevert(HookBlocks.InvalidSchedule.selector);
        new HookBlocks(
            address(vault),
            address(weth),
            address(hookr),
            address(pm),
            FEE,
            SPACING,
            _poolId(address(hookr)),
            sponsor,
            startAt,
            endAt,
            endAt, // sweep == end
            MIN_OUT_BPS,
            MAX_BUY,
            MIN_BUY
        );
    }

    function test_constructor_rejectsBadBounds() public {
        vm.expectRevert(HookBlocks.InvalidBounds.selector);
        new HookBlocks(
            address(vault),
            address(weth),
            address(hookr),
            address(pm),
            FEE,
            SPACING,
            _poolId(address(hookr)),
            sponsor,
            startAt,
            endAt,
            sweepAfter,
            0, // minOutBps zero
            MAX_BUY,
            MIN_BUY
        );
        vm.expectRevert(HookBlocks.InvalidBounds.selector);
        new HookBlocks(
            address(vault),
            address(weth),
            address(hookr),
            address(pm),
            FEE,
            SPACING,
            _poolId(address(hookr)),
            sponsor,
            startAt,
            endAt,
            sweepAfter,
            MIN_OUT_BPS,
            MIN_BUY, // max < min
            MAX_BUY
        );
        vm.expectRevert(HookBlocks.InvalidBounds.selector);
        new HookBlocks(
            address(vault),
            address(weth),
            address(hookr),
            address(pm),
            FEE,
            SPACING,
            _poolId(address(hookr)),
            sponsor,
            startAt,
            endAt,
            sweepAfter,
            MIN_OUT_BPS,
            uint256(type(uint128).max) + 1, // cap beyond the ledger's uint128
            MIN_BUY
        );
    }

    function test_constructor_rejectsPoolIdMismatch() public {
        bytes32 wrong = keccak256("wrong pool");
        vm.expectRevert(abi.encodeWithSelector(HookBlocks.PoolIdMismatch.selector, wrong, _poolId(address(hookr))));
        new HookBlocks(
            address(vault),
            address(weth),
            address(hookr),
            address(pm),
            FEE,
            SPACING,
            wrong,
            sponsor,
            startAt,
            endAt,
            sweepAfter,
            MIN_OUT_BPS,
            MAX_BUY,
            MIN_BUY
        );
    }

    function test_constructor_rejectsWrongVaultRewardAsset() public {
        MockWrongAssetVault wrongVault = new MockWrongAssetVault(address(hookr));
        vm.expectRevert(HookBlocks.WrongVaultRewardAsset.selector);
        _deploy(address(wrongVault), address(weth), address(hookr), address(pm));
    }

    function test_constructor_rejectsUninitializedPool() public {
        pm.setRawSqrtPrice(0);
        vm.expectRevert(HookBlocks.PoolNotInitialized.selector);
        _deploy(address(vault), address(weth), address(hookr), address(pm));
        pm.setRate(3_500_000e18);
    }

    // ---------------------------------------------------------------- funding

    function test_fund_onlySponsorOnceBeforeStart() public {
        vm.expectRevert(HookBlocks.OnlySponsor.selector);
        hb.fundFeeShares(1e18);

        vm.prank(sponsor);
        vm.expectRevert(HookBlocks.InvalidAmount.selector);
        hb.fundFeeShares(0);

        _fund();
        assertTrue(hb.feeSharesFunded());
        assertEq(hb.feeSharePrincipal(), 50e18);
        assertEq(vault.balanceOf(address(hb)), 50e18);

        vm.prank(sponsor);
        vm.expectRevert(HookBlocks.AlreadyFunded.selector);
        hb.fundFeeShares(1e18);
    }

    function test_fund_closedAtStart() public {
        vm.warp(startAt);
        vm.prank(sponsor);
        vm.expectRevert(HookBlocks.FundingClosed.selector);
        hb.fundFeeShares(50e18);
    }

    function test_fund_rejectsFeeOnTransferShares() public {
        vault.setFeeOnTransfer(true);
        vm.prank(sponsor);
        vm.expectRevert(HookBlocks.FeeShareTransferMismatch.selector);
        hb.fundFeeShares(50e18);
    }

    // ---------------------------------------------------------------- bonding

    function test_buyAndBurn_revertsUnfunded() public {
        vm.expectRevert(HookBlocks.NotFunded.selector);
        hb.buyAndBurn(0);
    }

    function test_buyAndBurn_happyPath_claimsSwapsAndRecords() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);

        uint256 expectedFloor = _floor(0.01 ether);
        uint256 expectedOut = (0.01 ether * 3_500_000e18) / 1e18;

        vm.prank(keeper);
        uint256 burned = hb.buyAndBurn(0);

        assertEq(burned, expectedOut);
        assertGe(burned, expectedFloor);
        // The contract keeps NO HOOKR: it all went to DEAD in this same tx.
        assertEq(hookr.balanceOf(address(hb)), 0);
        assertEq(hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED, expectedOut);
        assertEq(hb.totalHookrBurned(), expectedOut);
        assertEq(hb.totalEthSpent(), 0.01 ether);
        assertEq(hb.blockCount(), 1);
        HookBlocks.HookBlock memory blk = hb.hookBlock(0);
        assertEq(blk.ethIn, 0.01 ether);
        assertEq(blk.hookrBought, expectedOut);
        assertEq(blk.burnedAt, block.timestamp);
        // Nothing left behind: WETH fully drawn, native fully consumed.
        assertEq(weth.balanceOf(address(hb)), 0);
        assertEq(address(hb).balance, 0);
    }

    function test_buyAndBurn_emitsEvent() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        uint256 expectedOut = (0.01 ether * 3_500_000e18) / 1e18;
        vm.expectEmit(true, true, false, true, address(hb));
        emit HookBlocks.BoughtAndBurned(keeper, 0, 0.01 ether, expectedOut, expectedOut, _floor(0.01 ether));
        vm.prank(keeper);
        hb.buyAndBurn(0);
    }

    function test_buyAndBurn_rateLimitedPerBlock() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        hb.buyAndBurn(0);
        vault.setClaimable(address(hb), 0.01 ether);
        vm.expectRevert(HookBlocks.BuybackRateLimited.selector);
        hb.buyAndBurn(0);
        vm.roll(block.number + 1);
        hb.buyAndBurn(0); // next block is fine
    }

    function test_buyAndBurn_belowMinReverts() public {
        _fund();
        vault.setClaimable(address(hb), MIN_BUY - 1);
        vm.expectRevert(HookBlocks.BelowMinBuy.selector);
        hb.buyAndBurn(0);
    }

    function test_buyAndBurn_capsAtMaxPerCall() public {
        _fund();
        vault.setClaimable(address(hb), 0.2 ether); // 4x the cap

        hb.buyAndBurn(0);
        assertEq(hb.totalEthSpent(), MAX_BUY);
        // The residue stays as WETH for the next crank.
        assertEq(weth.balanceOf(address(hb)), 0.15 ether);

        vm.roll(block.number + 1);
        hb.buyAndBurn(0);
        assertEq(hb.totalEthSpent(), 2 * MAX_BUY);
        assertEq(hb.blockCount(), 2);
    }

    function test_buyAndBurn_floorNotMet_revertsAndLosesNothing() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        uint256 convertibleBefore = hb.pendingWeth();
        // Execution pays 5% under the quoted spot; the 9700 bps floor catches
        // it and the WHOLE call unwinds — including the vault claim, which is
        // why the reward is still pending afterward rather than held here.
        pm.setExecRate(3_325_000e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                HookBlocks.FloorNotMet.selector, _floor(0.01 ether), (0.01 ether * 3_325_000e18) / 1e18
            )
        );
        hb.buyAndBurn(0);

        assertEq(hb.totalHookrBurned(), 0);
        assertEq(hb.blockCount(), 0);
        assertEq(vault.pendingClaim(address(hb)), 0.01 ether); // claim un-consumed
        assertEq(hb.pendingWeth(), convertibleBefore); // nothing lost
    }

    function test_buyAndBurn_tolerableSlippagePasses() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        // 2% under spot clears a 9700 bps floor.
        pm.setExecRate(3_430_000e18);
        uint256 burned = hb.buyAndBurn(0);
        assertEq(burned, (0.01 ether * 3_430_000e18) / 1e18);
    }

    function test_buyAndBurn_callerFloorTightens() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        uint256 out = (0.01 ether * 3_500_000e18) / 1e18;
        vm.expectRevert(abi.encodeWithSelector(HookBlocks.FloorNotMet.selector, out + 1, out));
        hb.buyAndBurn(out + 1);
    }

    function test_buyAndBurn_zeroFloorRefused() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setSpotRate(0); // quoted spot collapses to zero
        pm.setRawSqrtPrice(1); // still "initialized", but floors to nothing
        vm.expectRevert(HookBlocks.FloorTooLow.selector);
        hb.buyAndBurn(0);
    }

    function test_buyAndBurn_vaultRevertDegradesToHeldWeth() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        hb.buyAndBurn(0); // consume the pending claim
        vm.roll(block.number + 1);

        weth.mint(address(hb), 0.02 ether); // reward already held
        vault.setReverts(true);
        uint256 burned = hb.buyAndBurn(0);
        assertEq(burned, (0.02 ether * 3_500_000e18) / 1e18);
    }

    function test_buyAndBurn_reentrancyThroughVaultBlocked() public {
        _fund();
        weth.mint(address(hb), 0.01 ether);
        vault.setReenter(address(hb));
        // The reentrant inner bond() reverts, the outer claimFor try/catch
        // swallows it, and the crank still completes on held WETH.
        uint256 burned = hb.buyAndBurn(0);
        assertEq(burned, (0.01 ether * 3_500_000e18) / 1e18);
        assertEq(hb.blockCount(), 1);
    }

    function test_buyAndBurn_reentrancyThroughPoolManagerBlocked() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setReenterOnTake(address(hb));
        vm.expectRevert(); // inner bond() hits the mutex and unwinds the swap
        hb.buyAndBurn(0);
    }

    function test_buyAndBurn_partialFillRecordsActualSpendAndCarriesResidue() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        // A 90% fill that still clears the floor quoted on the full input:
        // the ledger must record what was ACTUALLY spent, and the unspent
        // native must carry into the next call's cap arithmetic.
        pm.setConsumeCap(0.009 ether);
        pm.setExecRate(4_200_000e18);

        hb.buyAndBurn(0);
        assertEq(hb.totalEthSpent(), 0.009 ether);
        assertEq(hb.hookBlock(0).ethIn, 0.009 ether);
        assertEq(address(hb).balance, 0.001 ether); // residue, not lost

        // The residue counts toward the next call's MAX_BUY_WEI room.
        vm.roll(block.number + 1);
        pm.setConsumeCap(type(uint256).max);
        pm.setRate(3_500_000e18);
        vault.setClaimable(address(hb), 0.2 ether);
        hb.buyAndBurn(0);
        assertEq(hb.hookBlock(1).ethIn, MAX_BUY);
    }

    function test_buyAndBurn_partialFillBelowFloorStillReverts() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setConsumeCap(0.004 ether);
        // Output on 0.004 cannot clear a floor quoted on 0.01, so the spot
        // floor correctly rejects this partial fill.
        vm.expectRevert();
        hb.buyAndBurn(0);
    }

    function test_buyAndBurn_nativeDonationJoinsNextBuyWithinCap() public {
        _fund();
        vm.deal(address(hb), 0.03 ether); // force-set native balance
        vault.setClaimable(address(hb), 0.04 ether);
        hb.buyAndBurn(0);
        // Cap still binds the total converted input.
        assertEq(hb.totalEthSpent(), MAX_BUY);
        // room was 0.02, so 0.02 of WETH stayed wrapped.
        assertEq(weth.balanceOf(address(hb)), 0.02 ether);
    }

    function test_buyAndBurn_worksAfterFinalizeForResidual() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        vm.warp(endAt + 1);
        hb.finalize();
        // The final claim inside finalize() pulled the reward as WETH.
        assertEq(weth.balanceOf(address(hb)), 0.01 ether);
        uint256 burned = hb.buyAndBurn(0);
        assertEq(burned, (0.01 ether * 3_500_000e18) / 1e18);
    }

    function test_buyAndBurn_outputOverUint128Refused() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setOverMintWei(uint256(type(uint128).max));
        vm.expectRevert(HookBlocks.AmountTooLarge.selector);
        hb.buyAndBurn(0);
    }

    // ------------------------------------------------------ unlock callback

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(HookBlocks.OnlyPoolManager.selector);
        hb.unlockCallback(abi.encode(uint256(1)));
    }

    function test_unlockCallback_requiresOpenBuy() public {
        vm.prank(address(pm));
        vm.expectRevert(HookBlocks.UnexpectedUnlock.selector);
        hb.unlockCallback(abi.encode(uint256(1)));
    }

    function test_buyAndBurn_skippedCallbackFailsClosed() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setSkipCallback(true);
        // No callback means no output; the floor check refuses the empty fill.
        vm.expectRevert();
        hb.buyAndBurn(0);
    }

    function test_buyAndBurn_shortPaidTakeFailsFloor() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setShortPayTake(true);
        // The PM's reported delta claims full output but pays half; the
        // measured-balance floor catches the lie.
        vm.expectRevert();
        hb.buyAndBurn(0);
    }

    // ------------------------------------------------------------ burn proofs

    function test_burn_sendsEverythingToDeadSameTransaction() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        uint256 expectedOut = (0.01 ether * 3_500_000e18) / 1e18;

        hb.buyAndBurn(0);

        // The destination is the canonical dead address, and the amount there
        // is exactly what the ledger claims — the published number is
        // verifiable without trusting this contract at all.
        assertEq(hb.DEAD(), 0x000000000000000000000000000000000000dEaD);
        assertEq(hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED, expectedOut);
        assertEq(hb.totalHookrBurned(), expectedOut);
        assertEq(hookr.balanceOf(address(hb)), 0);
    }

    function test_burn_sweepsDonatedHookrToDeadToo() public {
        _fund();
        // Someone dumps HOOKR on the contract. It must not sit here forever.
        hookr.mint(address(hb), 5e18);
        vault.setClaimable(address(hb), 0.01 ether);
        uint256 bought = (0.01 ether * 3_500_000e18) / 1e18;

        uint256 burned = hb.buyAndBurn(0);

        // The donation is burned alongside the purchase, and the ledger says
        // so: nothing lingers in the contract.
        assertEq(burned, bought + 5e18);
        assertEq(hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED, bought + 5e18);
        assertEq(hookr.balanceOf(address(hb)), 0);
    }

    function test_burn_floorIsCheckedOnPurchaseNotOnDonation() public {
        _fund();
        // A donation must NOT be able to satisfy the slippage floor on behalf
        // of a bad execution — the floor is measured on the swap output only.
        hookr.mint(address(hb), 1_000_000e18);
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setExecRate(1e18); // catastrophic execution
        // Selector-exact: if the floor were ever moved onto the full balance,
        // the donation would satisfy it and this would stop reverting.
        vm.expectRevert(abi.encodeWithSelector(HookBlocks.FloorNotMet.selector, _floor(0.01 ether), 0.01 ether));
        hb.buyAndBurn(0);
    }

    function test_burn_rejectsFeeOnTransferShortfall() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        // A token that shaves the transfer would make the published burn total
        // a lie; the destination-measured check refuses it.
        hookr.setFeeOnTransfer(true);
        vm.expectRevert(HookBlocks.BurnTransferMismatch.selector);
        hb.buyAndBurn(0);
    }

    function testFuzz_burn_contractNeverRetainsHookr(uint256 claimWei, uint256 donation) public {
        claimWei = bound(claimWei, MIN_BUY, 1 ether);
        donation = bound(donation, 0, 1_000e18);
        _fund();
        if (donation != 0) hookr.mint(address(hb), donation);
        vault.setClaimable(address(hb), claimWei);

        uint256 rounds;
        while (rounds < 40) {
            (bool ok,) = address(hb).call(abi.encodeWithSelector(HookBlocks.buyAndBurn.selector, uint256(0)));
            if (!ok) break;
            // The invariant holds after EVERY crank, not just at the end.
            assertEq(hookr.balanceOf(address(hb)), 0);
            assertEq(hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED, hb.totalHookrBurned());
            vm.roll(block.number + 1);
            rounds++;
        }
        assertGt(rounds, 0);
    }

    function test_burn_ledgerRecordsPurchaseNotDonation() public {
        _fund();
        // The griefing vector the ledger must resist: donate HOOKR, then let
        // a crank run. The donation IS burned (nothing stranded), but it must
        // never be credited as something this block's ETH bought, or anyone
        // could inflate the campaign's published execution rate forever.
        hookr.mint(address(hb), 900_000e18);
        vault.setClaimable(address(hb), 0.01 ether);
        uint256 bought = (0.01 ether * 3_500_000e18) / 1e18;

        uint256 burned = hb.buyAndBurn(0);

        assertEq(burned, bought + 900_000e18); // everything reached DEAD
        assertEq(hb.totalHookrBurned(), bought + 900_000e18);
        // ...but the ledger and the buy total record only the purchase.
        assertEq(hb.hookBlock(0).hookrBought, bought);
        assertEq(hb.totalHookrBought(), bought);
        // The published execution rate is therefore un-inflatable.
        assertEq(hb.totalHookrBought() / (hb.totalEthSpent() / 1e18 == 0 ? 1 : 1), bought);
    }

    function test_burn_eventPublishesBoughtAndBurnedSeparately() public {
        _fund();
        hookr.mint(address(hb), 1_000e18);
        vault.setClaimable(address(hb), 0.01 ether);
        uint256 bought = (0.01 ether * 3_500_000e18) / 1e18;
        // An observer must be able to check `hookrBought >= floor` from the
        // event alone, so both figures are emitted.
        vm.expectEmit(true, true, false, true, address(hb));
        emit HookBlocks.BoughtAndBurned(address(this), 0, 0.01 ether, bought, bought + 1_000e18, _floor(0.01 ether));
        hb.buyAndBurn(0);
    }

    function test_burn_hugeDonationCannotBrickTheCrank() public {
        _fund();
        // A donation larger than uint128 must not be able to permanently
        // brick conversion: the ledger bound applies to the pool-bounded
        // purchase, and the burn total is a uint256.
        hookr.mint(address(hb), uint256(type(uint128).max) + 1);
        vault.setClaimable(address(hb), 0.01 ether);
        uint256 burned = hb.buyAndBurn(0);
        assertGt(burned, uint256(type(uint128).max));
        assertEq(hookr.balanceOf(address(hb)), 0);
    }

    function test_burn_reentrancyThroughHookrTransferBlocked() public {
        // The burn added an outbound call to the HOOKR token. A token that
        // re-enters from it must not be able to drive a second conversion.
        MockReentrantHookr evil = new MockReentrantHookr();
        MockPoolManager evilPm = new MockPoolManager(evil);
        evilPm.setRate(3_500_000e18);
        HookBlocks target = _deploy(address(vault), address(weth), address(evil), address(evilPm));
        vault.mint(sponsor, 50e18);
        vm.startPrank(sponsor);
        vault.approve(address(target), type(uint256).max);
        target.fundFeeShares(50e18);
        vm.stopPrank();
        vault.setClaimable(address(target), 0.01 ether);

        evil.arm(address(target), 1); // re-enter buyAndBurn from transfer
        vm.expectRevert();
        target.buyAndBurn(0);
    }

    function test_burn_reentrancyThroughSweepBlocked() public {
        MockReentrantHookr evil = new MockReentrantHookr();
        MockPoolManager evilPm = new MockPoolManager(evil);
        evilPm.setRate(3_500_000e18);
        HookBlocks target = _deploy(address(vault), address(weth), address(evil), address(evilPm));
        vault.mint(sponsor, 50e18);
        vm.startPrank(sponsor);
        vault.approve(address(target), type(uint256).max);
        target.fundFeeShares(50e18);
        vm.stopPrank();

        evil.mint(address(target), 5e18);
        weth.mint(address(target), 1e18);
        vm.warp(endAt + 1);
        evil.arm(address(target), 2); // re-enter sweepUnspent from transfer
        vm.prank(sponsor);
        vm.expectRevert();
        target.sweepUnspent();
    }

    function test_sweep_burnsStrandedHookrRatherThanTrappingIt() public {
        _fund();
        // The pool dies, so conversion is impossible and a donation would
        // otherwise sit here forever. The sweep must burn it, not pay it out.
        hookr.mint(address(hb), 5e18);
        weth.mint(address(hb), 0.02 ether);
        vm.prank(sponsor);
        hb.setBuybackPaused(true);
        vm.warp(sweepAfter + 1);

        uint256 deadBefore = hookr.balanceOf(hb.DEAD());
        hb.sweepUnspent();

        assertEq(weth.balanceOf(sponsor), 0.02 ether); // WETH recovered
        assertEq(hookr.balanceOf(hb.DEAD()) - deadBefore, 5e18); // HOOKR burned
        assertEq(hookr.balanceOf(address(hb)), 0); // nothing trapped
        assertEq(hookr.balanceOf(sponsor), 0); // and never diverted
        assertEq(hb.totalHookrBurned(), 5e18);
    }

    function test_sweep_hookrAloneIsEnoughToSweep() public {
        _fund();
        hookr.mint(address(hb), 3e18);
        vm.warp(sweepAfter + 1);
        hb.sweepUnspent(); // must not revert NothingToSweep
        assertEq(hookr.balanceOf(address(hb)), 0);
    }

    // ------------------------------------------------------- admin safeguards

    function test_pause_onlySponsor() public {
        vm.expectRevert(HookBlocks.OnlySponsor.selector);
        hb.setBuybackPaused(true);
        assertFalse(hb.buybackPaused());
    }

    function test_pause_gatesBuysOnlyAndUnpauses() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);

        vm.prank(sponsor);
        hb.setBuybackPaused(true);
        vm.expectRevert(HookBlocks.BuybackPaused.selector);
        hb.buyAndBurn(0);

        // Unpause restores the permissionless crank unchanged.
        vm.prank(sponsor);
        hb.setBuybackPaused(false);
        uint256 burned = hb.buyAndBurn(0);
        assertEq(burned, (0.01 ether * 3_500_000e18) / 1e18);
    }

    function test_pause_emitsEvent() public {
        vm.expectEmit(false, false, false, true, address(hb));
        emit HookBlocks.BuybackPauseSet(true);
        vm.prank(sponsor);
        hb.setBuybackPaused(true);
    }

    function test_pause_neverBlocksFinalizeOrSweep() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        vm.prank(sponsor);
        hb.setBuybackPaused(true);

        // Finalize runs paused: principal is never behind the switch.
        vm.warp(endAt + 1);
        hb.finalize();
        assertEq(vault.balanceOf(sponsor), 50e18);

        // The final defensive claim inside finalize pulled the reward as
        // WETH; with bonding paused, the sponsor's early sweep recovers it.
        assertEq(weth.balanceOf(address(hb)), 0.01 ether);
        vm.prank(sponsor);
        hb.sweepUnspent();
        assertEq(weth.balanceOf(sponsor), 0.01 ether);
    }

    function test_sweep_sponsorMayRecoverFromEndAt() public {
        _fund();
        weth.mint(address(hb), 0.02 ether);
        vm.warp(endAt + 1);

        // Before SWEEP_AFTER a non-sponsor is still gated...
        vm.prank(keeper);
        vm.expectRevert(HookBlocks.SweepNotOpen.selector);
        hb.sweepUnspent();

        // ...but the sponsor recovers the stuck leg immediately.
        vm.prank(sponsor);
        hb.sweepUnspent();
        assertEq(weth.balanceOf(sponsor), 0.02 ether);
    }

    function test_sweep_nobodyBeforeEndAt_sponsorIncluded() public {
        _fund();
        weth.mint(address(hb), 0.02 ether);
        vm.warp(endAt); // the window's last second is still inside the term
        vm.prank(sponsor);
        vm.expectRevert(HookBlocks.SweepNotOpen.selector);
        hb.sweepUnspent();
    }

    function test_safeguards_canNeverTouchHookr() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        hb.buyAndBurn(0);
        uint256 burned = hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED;
        assertGt(burned, 0);
        assertEq(hookr.balanceOf(address(hb)), 0);

        // Pause, finalize, early-sweep with residue: the ledger and the
        // HOOKR balance are byte-identical afterward.
        vm.prank(sponsor);
        hb.setBuybackPaused(true);
        weth.mint(address(hb), 0.01 ether);
        vm.warp(endAt + 1);
        hb.finalize();
        vm.prank(sponsor);
        hb.sweepUnspent();

        assertEq(hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED, burned);
        assertEq(hb.totalHookrBurned(), burned);
        assertEq(hookr.balanceOf(address(hb)), 0);
        assertEq(hookr.balanceOf(sponsor), 0);
    }

    // ------------------------------------------------------------ settlement

    function test_finalize_gatesAndReturnsExactPrincipal() public {
        vm.expectRevert(HookBlocks.NotFunded.selector);
        hb.finalize();

        _fund();
        vm.expectRevert(HookBlocks.TermNotEnded.selector);
        hb.finalize();

        vm.warp(endAt + 1);
        uint256 sponsorBefore = vault.balanceOf(sponsor);
        hb.finalize();
        assertTrue(hb.finalized());
        assertEq(hb.feeSharePrincipal(), 0);
        assertEq(vault.balanceOf(sponsor), sponsorBefore + 50e18);
        assertEq(vault.balanceOf(address(hb)), 0);

        vm.expectRevert(HookBlocks.AlreadyFinalized.selector);
        hb.finalize();
    }

    function test_finalize_survivesVaultRevert() public {
        _fund();
        vault.setReverts(true);
        vm.warp(endAt + 1);
        hb.finalize(); // the final claim is best-effort, the return is not
        assertEq(vault.balanceOf(sponsor), 50e18);
    }

    function test_finalize_donatedSharesStay() public {
        _fund();
        vault.mint(address(hb), 7e18); // stray donation on top of principal
        vm.warp(endAt + 1);
        hb.finalize();
        // Exactly the principal moved; the donation is inert forever.
        assertEq(vault.balanceOf(sponsor), 50e18);
        assertEq(vault.balanceOf(address(hb)), 7e18);
    }

    // ----------------------------------------------------------------- sweep

    function test_sweep_gatedUntilWindow() public {
        weth.mint(address(hb), 1 ether);
        vm.expectRevert(HookBlocks.SweepNotOpen.selector);
        hb.sweepUnspent();
    }

    function test_sweep_nothingToSweepReverts() public {
        vm.warp(sweepAfter + 1);
        vm.expectRevert(HookBlocks.NothingToSweep.selector);
        hb.sweepUnspent();
    }

    function test_sweep_recoversResidueNeverHookr() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        hb.buyAndBurn(0);
        uint256 burnedHookr = hb.totalHookrBurned();

        weth.mint(address(hb), 0.03 ether);
        vm.deal(address(hb), 0.002 ether);
        vm.warp(sweepAfter + 1);
        hb.sweepUnspent();

        assertEq(weth.balanceOf(sponsor), 0.03 ether);
        assertEq(sponsor.balance, 0.002 ether);
        // The bonded ledger and balance are untouched, permanently.
        // Burned HOOKR is at DEAD and the contract holds none, so the sweep
        // has nothing of it to touch even in principle.
        assertEq(hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED, burnedHookr);
        assertEq(hb.totalHookrBurned(), burnedHookr);
        assertEq(hookr.balanceOf(address(hb)), 0);
    }

    // ------------------------------------------------------------ permanence

    function test_permanence_noPathMovesHookr() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        hb.buyAndBurn(0);
        uint256 burned = hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED;
        assertGt(burned, 0);

        // Walk the entire lifecycle: nothing retrieves burned HOOKR.
        vm.warp(endAt + 1);
        hb.finalize();
        vm.roll(block.number + 1);
        weth.mint(address(hb), 0.01 ether);
        hb.buyAndBurn(0); // residual bond only adds
        vm.warp(sweepAfter + 1);
        weth.mint(address(hb), 1);
        hb.sweepUnspent();

        assertGe(hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED, burned);
        assertEq(hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED, hb.totalHookrBurned());
        assertEq(hookr.balanceOf(address(hb)), 0);
        assertEq(hookr.balanceOf(sponsor), 0);
    }

    // --------------------------------------------------------------- receive

    function test_receive_rejectsPlainNative() public {
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        (bool ok,) = address(hb).call{value: 0.1 ether}("");
        assertFalse(ok);
    }

    // ----------------------------------------------------------------- views

    function test_pendingWeth_aggregatesAndDegrades() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        weth.mint(address(hb), 0.02 ether);
        vm.deal(address(hb), 0.003 ether);
        assertEq(hb.pendingWeth(), 0.033 ether);
        vault.setReverts(true);
        assertEq(hb.pendingWeth(), 0.023 ether); // view revert degrades to held
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_buyAndBurn_ledgerMatchesBalances(uint256 claimWei, uint256 rate) public {
        claimWei = bound(claimWei, MIN_BUY, 5 ether);
        rate = bound(rate, 1e18, 1e26);
        pm.setRate(rate);
        _fund();
        vault.setClaimable(address(hb), claimWei);

        uint256 rounds;
        while (rounds < 120) {
            uint256 before = hb.totalEthSpent();
            (bool ok, bytes memory ret) =
                address(hb).call(abi.encodeWithSelector(HookBlocks.buyAndBurn.selector, uint256(0)));
            if (!ok) break;
            uint256 burned = abi.decode(ret, (uint256));
            assertLe(hb.totalEthSpent() - before, MAX_BUY); // per-call cap holds
            assertGt(burned, 0);
            vm.roll(block.number + 1);
            rounds++;
        }

        // The ledger IS the balance: every bonded token is still here, and
        // block entries sum exactly to the totals.
        assertEq(hookr.balanceOf(hb.DEAD()) - DEAD_PRESEED, hb.totalHookrBurned());
        assertEq(hookr.balanceOf(address(hb)), 0);
        uint256 sumEth;
        uint256 sumHookr;
        for (uint256 i; i < hb.blockCount(); i++) {
            HookBlocks.HookBlock memory blk = hb.hookBlock(i);
            sumEth += blk.ethIn;
            sumHookr += blk.hookrBought;
        }
        assertEq(sumEth, hb.totalEthSpent());
        assertEq(sumHookr, hb.totalHookrBought());
        // Nothing was lost: whatever was not bonded is still WETH or native.
        assertEq(weth.balanceOf(address(hb)) + address(hb).balance + hb.totalEthSpent(), claimWei);
    }

    function testFuzz_buyAndBurn_floorRejectsUnderpricedExecution(uint256 execBps) public {
        execBps = bound(execBps, 1, 12_000);
        uint256 spotRate = 3_500_000e18;
        pm.setSpotRate(spotRate);
        pm.setExecRate((spotRate * execBps) / 10_000);
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);

        uint256 floor = _floor(0.01 ether);
        uint256 out = (0.01 ether * ((spotRate * execBps) / 10_000)) / 1e18;
        if (out >= floor) {
            assertEq(hb.buyAndBurn(0), out);
        } else {
            vm.expectRevert(abi.encodeWithSelector(HookBlocks.FloorNotMet.selector, floor, out));
            hb.buyAndBurn(0);
        }
    }

    function testFuzz_fund_exactTransferOnly(uint256 amount) public {
        amount = bound(amount, 1, 50e18);
        vm.prank(sponsor);
        hb.fundFeeShares(amount);
        assertEq(hb.feeSharePrincipal(), amount);
        assertEq(vault.balanceOf(address(hb)), amount);
    }
}
