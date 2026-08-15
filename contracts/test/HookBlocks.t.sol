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
            HookBlocks(payable(reenterTarget)).bond(0);
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
            HookBlocks(payable(reenterTarget)).bond(0);
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
    uint256 internal constant MAX_BOND = 0.05 ether;
    uint256 internal constant MIN_BOND = 0.0005 ether;
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

    function setUp() public {
        vm.chainId(CHAIN);
        weth = new MockWeth();
        hookr = new MockToken("HOOKR");
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
            MAX_BOND,
            MIN_BOND
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
            MAX_BOND,
            MIN_BOND
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
            MAX_BOND,
            MIN_BOND
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
            MAX_BOND,
            MIN_BOND
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
            MAX_BOND,
            MIN_BOND
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
            MIN_BOND, // max < min
            MAX_BOND
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
            MIN_BOND
        );
    }

    function test_constructor_rejectsPoolIdMismatch() public {
        bytes32 wrong = keccak256("wrong pool");
        vm.expectRevert(
            abi.encodeWithSelector(HookBlocks.PoolIdMismatch.selector, wrong, _poolId(address(hookr)))
        );
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
            MAX_BOND,
            MIN_BOND
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

    function test_bond_revertsUnfunded() public {
        vm.expectRevert(HookBlocks.NotFunded.selector);
        hb.bond(0);
    }

    function test_bond_happyPath_claimsSwapsAndRecords() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);

        uint256 expectedFloor = _floor(0.01 ether);
        uint256 expectedOut = (0.01 ether * 3_500_000e18) / 1e18;

        vm.prank(keeper);
        uint256 bonded = hb.bond(0);

        assertEq(bonded, expectedOut);
        assertGe(bonded, expectedFloor);
        assertEq(hookr.balanceOf(address(hb)), expectedOut);
        assertEq(hb.totalHookrBonded(), expectedOut);
        assertEq(hb.totalEthBonded(), 0.01 ether);
        assertEq(hb.blockCount(), 1);
        HookBlocks.HookBlock memory blk = hb.hookBlock(0);
        assertEq(blk.ethIn, 0.01 ether);
        assertEq(blk.hookrBonded, expectedOut);
        assertEq(blk.bondedAt, block.timestamp);
        // Nothing left behind: WETH fully drawn, native fully consumed.
        assertEq(weth.balanceOf(address(hb)), 0);
        assertEq(address(hb).balance, 0);
    }

    function test_bond_emitsEvent() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        uint256 expectedOut = (0.01 ether * 3_500_000e18) / 1e18;
        vm.expectEmit(true, true, false, true, address(hb));
        emit HookBlocks.Bonded(keeper, 0, 0.01 ether, expectedOut, _floor(0.01 ether));
        vm.prank(keeper);
        hb.bond(0);
    }

    function test_bond_rateLimitedPerBlock() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        hb.bond(0);
        vault.setClaimable(address(hb), 0.01 ether);
        vm.expectRevert(HookBlocks.BondRateLimited.selector);
        hb.bond(0);
        vm.roll(block.number + 1);
        hb.bond(0); // next block is fine
    }

    function test_bond_belowMinReverts() public {
        _fund();
        vault.setClaimable(address(hb), MIN_BOND - 1);
        vm.expectRevert(HookBlocks.BelowMinBond.selector);
        hb.bond(0);
    }

    function test_bond_capsAtMaxPerCall() public {
        _fund();
        vault.setClaimable(address(hb), 0.2 ether); // 4x the cap

        hb.bond(0);
        assertEq(hb.totalEthBonded(), MAX_BOND);
        // The residue stays as WETH for the next crank.
        assertEq(weth.balanceOf(address(hb)), 0.15 ether);

        vm.roll(block.number + 1);
        hb.bond(0);
        assertEq(hb.totalEthBonded(), 2 * MAX_BOND);
        assertEq(hb.blockCount(), 2);
    }

    function test_bond_floorNotMet_revertsAndKeepsWeth() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        // Execution pays 5% under the quoted spot; 9700 bps floor catches it.
        pm.setExecRate(3_325_000e18);
        vm.expectRevert();
        hb.bond(0);
        // The WETH was claimed from the vault but never left as a bond.
        assertEq(hb.totalHookrBonded(), 0);
    }

    function test_bond_tolerableSlippagePasses() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        // 2% under spot clears a 9700 bps floor.
        pm.setExecRate(3_430_000e18);
        uint256 bonded = hb.bond(0);
        assertEq(bonded, (0.01 ether * 3_430_000e18) / 1e18);
    }

    function test_bond_callerFloorTightens() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        uint256 out = (0.01 ether * 3_500_000e18) / 1e18;
        vm.expectRevert(abi.encodeWithSelector(HookBlocks.FloorNotMet.selector, out + 1, out));
        hb.bond(out + 1);
    }

    function test_bond_zeroFloorRefused() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setSpotRate(0); // quoted spot collapses to zero
        pm.setRawSqrtPrice(1); // still "initialized", but floors to nothing
        vm.expectRevert(HookBlocks.FloorTooLow.selector);
        hb.bond(0);
    }

    function test_bond_vaultRevertDegradesToHeldWeth() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        hb.bond(0); // consume the pending claim
        vm.roll(block.number + 1);

        weth.mint(address(hb), 0.02 ether); // reward already held
        vault.setReverts(true);
        uint256 bonded = hb.bond(0);
        assertEq(bonded, (0.02 ether * 3_500_000e18) / 1e18);
    }

    function test_bond_reentrancyThroughVaultBlocked() public {
        _fund();
        weth.mint(address(hb), 0.01 ether);
        vault.setReenter(address(hb));
        // The reentrant inner bond() reverts, the outer claimFor try/catch
        // swallows it, and the crank still completes on held WETH.
        uint256 bonded = hb.bond(0);
        assertEq(bonded, (0.01 ether * 3_500_000e18) / 1e18);
        assertEq(hb.blockCount(), 1);
    }

    function test_bond_reentrancyThroughPoolManagerBlocked() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setReenterOnTake(address(hb));
        vm.expectRevert(); // inner bond() hits the mutex and unwinds the swap
        hb.bond(0);
    }

    function test_bond_partialConsumptionRecordsActualSpend() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setConsumeCap(0.004 ether);
        // Executed output (on 0.004) cannot clear a floor quoted on 0.01, so
        // the caller must accept it explicitly with a stricter-truth floor of
        // their own; the spot floor correctly rejects the partial fill.
        vm.expectRevert();
        hb.bond(0);
    }

    function test_bond_nativeDonationJoinsNextBondWithinCap() public {
        _fund();
        vm.deal(address(hb), 0.03 ether); // force-set native balance
        vault.setClaimable(address(hb), 0.04 ether);
        hb.bond(0);
        // Cap still binds the total converted input.
        assertEq(hb.totalEthBonded(), MAX_BOND);
        // room was 0.02, so 0.02 of WETH stayed wrapped.
        assertEq(weth.balanceOf(address(hb)), 0.02 ether);
    }

    function test_bond_worksAfterFinalizeForResidual() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        vm.warp(endAt + 1);
        hb.finalize();
        // The final claim inside finalize() pulled the reward as WETH.
        assertEq(weth.balanceOf(address(hb)), 0.01 ether);
        uint256 bonded = hb.bond(0);
        assertEq(bonded, (0.01 ether * 3_500_000e18) / 1e18);
    }

    function test_bond_outputOverUint128Refused() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setOverMintWei(uint256(type(uint128).max));
        vm.expectRevert(HookBlocks.AmountTooLarge.selector);
        hb.bond(0);
    }

    // ------------------------------------------------------ unlock callback

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(HookBlocks.OnlyPoolManager.selector);
        hb.unlockCallback(abi.encode(uint256(1)));
    }

    function test_unlockCallback_requiresOpenBond() public {
        vm.prank(address(pm));
        vm.expectRevert(HookBlocks.UnexpectedUnlock.selector);
        hb.unlockCallback(abi.encode(uint256(1)));
    }

    function test_bond_skippedCallbackFailsClosed() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setSkipCallback(true);
        // No callback means no output; the floor check refuses the empty fill.
        vm.expectRevert();
        hb.bond(0);
    }

    function test_bond_shortPaidTakeFailsFloor() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        pm.setShortPayTake(true);
        // The PM's reported delta claims full output but pays half; the
        // measured-balance floor catches the lie.
        vm.expectRevert();
        hb.bond(0);
    }

    // ------------------------------------------------------- admin safeguards

    function test_pause_onlySponsor() public {
        vm.expectRevert(HookBlocks.OnlySponsor.selector);
        hb.setBondingPaused(true);
        assertFalse(hb.bondingPaused());
    }

    function test_pause_gatesBondOnlyAndUnpauses() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);

        vm.prank(sponsor);
        hb.setBondingPaused(true);
        vm.expectRevert(HookBlocks.BondingPaused.selector);
        hb.bond(0);

        // Unpause restores the permissionless crank unchanged.
        vm.prank(sponsor);
        hb.setBondingPaused(false);
        uint256 bonded = hb.bond(0);
        assertEq(bonded, (0.01 ether * 3_500_000e18) / 1e18);
    }

    function test_pause_emitsEvent() public {
        vm.expectEmit(false, false, false, true, address(hb));
        emit HookBlocks.BondingPauseSet(true);
        vm.prank(sponsor);
        hb.setBondingPaused(true);
    }

    function test_pause_neverBlocksFinalizeOrSweep() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        vm.prank(sponsor);
        hb.setBondingPaused(true);

        // Finalize runs paused: principal is never behind the switch.
        vm.warp(endAt + 1);
        hb.finalize();
        assertEq(vault.balanceOf(sponsor), 50e18);

        // The final defensive claim inside finalize pulled the reward as
        // WETH; with bonding paused, the sponsor's early sweep recovers it.
        assertEq(weth.balanceOf(address(hb)), 0.01 ether);
        vm.prank(sponsor);
        hb.sweepUnbonded();
        assertEq(weth.balanceOf(sponsor), 0.01 ether);
    }

    function test_sweep_sponsorMayRecoverFromEndAt() public {
        _fund();
        weth.mint(address(hb), 0.02 ether);
        vm.warp(endAt + 1);

        // Before SWEEP_AFTER a non-sponsor is still gated...
        vm.prank(keeper);
        vm.expectRevert(HookBlocks.SweepNotOpen.selector);
        hb.sweepUnbonded();

        // ...but the sponsor recovers the stuck leg immediately.
        vm.prank(sponsor);
        hb.sweepUnbonded();
        assertEq(weth.balanceOf(sponsor), 0.02 ether);
    }

    function test_sweep_nobodyBeforeEndAt_sponsorIncluded() public {
        _fund();
        weth.mint(address(hb), 0.02 ether);
        vm.warp(endAt); // the window's last second is still inside the term
        vm.prank(sponsor);
        vm.expectRevert(HookBlocks.SweepNotOpen.selector);
        hb.sweepUnbonded();
    }

    function test_safeguards_canNeverTouchHookr() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        hb.bond(0);
        uint256 bonded = hookr.balanceOf(address(hb));
        assertGt(bonded, 0);

        // Pause, finalize, early-sweep with residue: the ledger and the
        // HOOKR balance are byte-identical afterward.
        vm.prank(sponsor);
        hb.setBondingPaused(true);
        weth.mint(address(hb), 0.01 ether);
        vm.warp(endAt + 1);
        hb.finalize();
        vm.prank(sponsor);
        hb.sweepUnbonded();

        assertEq(hookr.balanceOf(address(hb)), bonded);
        assertEq(hb.totalHookrBonded(), bonded);
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
        hb.sweepUnbonded();
    }

    function test_sweep_nothingToSweepReverts() public {
        vm.warp(sweepAfter + 1);
        vm.expectRevert(HookBlocks.NothingToSweep.selector);
        hb.sweepUnbonded();
    }

    function test_sweep_recoversResidueNeverHookr() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        hb.bond(0);
        uint256 bondedHookr = hb.totalHookrBonded();

        weth.mint(address(hb), 0.03 ether);
        vm.deal(address(hb), 0.002 ether);
        vm.warp(sweepAfter + 1);
        hb.sweepUnbonded();

        assertEq(weth.balanceOf(sponsor), 0.03 ether);
        assertEq(sponsor.balance, 0.002 ether);
        // The bonded ledger and balance are untouched, permanently.
        assertEq(hookr.balanceOf(address(hb)), bondedHookr);
        assertEq(hb.totalHookrBonded(), bondedHookr);
    }

    // ------------------------------------------------------------ permanence

    function test_permanence_noPathMovesHookr() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        hb.bond(0);
        uint256 bonded = hookr.balanceOf(address(hb));
        assertGt(bonded, 0);

        // Walk the entire lifecycle: nothing moves HOOKR.
        vm.warp(endAt + 1);
        hb.finalize();
        vm.roll(block.number + 1);
        weth.mint(address(hb), 0.01 ether);
        hb.bond(0); // residual bond only adds
        vm.warp(sweepAfter + 1);
        weth.mint(address(hb), 1);
        hb.sweepUnbonded();

        assertGe(hookr.balanceOf(address(hb)), bonded);
        assertEq(hookr.balanceOf(address(hb)), hb.totalHookrBonded());
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

    function test_bondableWeth_aggregatesAndDegrades() public {
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);
        weth.mint(address(hb), 0.02 ether);
        vm.deal(address(hb), 0.003 ether);
        assertEq(hb.bondableWeth(), 0.033 ether);
        vault.setReverts(true);
        assertEq(hb.bondableWeth(), 0.023 ether); // view revert degrades to held
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_bond_ledgerMatchesBalances(uint256 claimWei, uint256 rate) public {
        claimWei = bound(claimWei, MIN_BOND, 5 ether);
        rate = bound(rate, 1e18, 1e26);
        pm.setRate(rate);
        _fund();
        vault.setClaimable(address(hb), claimWei);

        uint256 rounds;
        while (rounds < 120) {
            uint256 before = hb.totalEthBonded();
            (bool ok, bytes memory ret) =
                address(hb).call(abi.encodeWithSelector(HookBlocks.bond.selector, uint256(0)));
            if (!ok) break;
            uint256 bonded = abi.decode(ret, (uint256));
            assertLe(hb.totalEthBonded() - before, MAX_BOND); // per-call cap holds
            assertGt(bonded, 0);
            vm.roll(block.number + 1);
            rounds++;
        }

        // The ledger IS the balance: every bonded token is still here, and
        // block entries sum exactly to the totals.
        assertEq(hookr.balanceOf(address(hb)), hb.totalHookrBonded());
        uint256 sumEth;
        uint256 sumHookr;
        for (uint256 i; i < hb.blockCount(); i++) {
            HookBlocks.HookBlock memory blk = hb.hookBlock(i);
            sumEth += blk.ethIn;
            sumHookr += blk.hookrBonded;
        }
        assertEq(sumEth, hb.totalEthBonded());
        assertEq(sumHookr, hb.totalHookrBonded());
        // Nothing was lost: whatever was not bonded is still WETH or native.
        assertEq(weth.balanceOf(address(hb)) + address(hb).balance + hb.totalEthBonded(), claimWei);
    }

    function testFuzz_bond_floorRejectsUnderpricedExecution(uint256 execBps) public {
        execBps = bound(execBps, 1, 12_000);
        uint256 spotRate = 3_500_000e18;
        pm.setSpotRate(spotRate);
        pm.setExecRate((spotRate * execBps) / 10_000);
        _fund();
        vault.setClaimable(address(hb), 0.01 ether);

        uint256 floor = _floor(0.01 ether);
        uint256 out = (0.01 ether * ((spotRate * execBps) / 10_000)) / 1e18;
        if (out >= floor) {
            assertEq(hb.bond(0), out);
        } else {
            vm.expectRevert(abi.encodeWithSelector(HookBlocks.FloorNotMet.selector, floor, out));
            hb.bond(0);
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
