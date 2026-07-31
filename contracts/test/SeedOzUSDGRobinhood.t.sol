// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {IOzSeedPermit2, IOzSeedRouteAdapter, OzUSDGAtomicSeeder} from "../src/operations/OzUSDGAtomicSeeder.sol";
import {IOzSeedV4Quoter, SeedOzUSDGRobinhood} from "../script/SeedOzUSDGRobinhood.s.sol";

contract AtomicSeedTokenMock {
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;
    mapping(address approver => uint256) public approveCallsByOwner;

    address public callbackTarget;
    bytes public callbackData;
    uint256 public callbackAttempts;
    bytes4 public callbackRevertSelector;

    function mint(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function burn(address account, uint256 amount) external {
        require(balanceOf[account] >= amount, "burn exceeds balance");
        balanceOf[account] -= amount;
    }

    function configureCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        ++approveCallsByOwner[msg.sender];
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (callbackTarget != address(0)) {
            address target = callbackTarget;
            bytes memory data = callbackData;
            callbackTarget = address(0);
            delete callbackData;
            ++callbackAttempts;
            (bool ok, bytes memory reason) = target.call(data);
            require(!ok, "callback unexpectedly succeeded");
            if (reason.length >= 4) {
                bytes4 selector;
                assembly ("memory-safe") {
                    selector := mload(add(reason, 0x20))
                }
                callbackRevertSelector = selector;
            }
        }

        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "insufficient allowance");
        require(balanceOf[from] >= amount, "insufficient balance");
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract AtomicSeedRegistryMock {
    address public owner;
    address public pendingOwner;
    mapping(address target => bool) public isAllowed;

    function configureOwner(address owner_, address pendingOwner_) external {
        owner = owner_;
        pendingOwner = pendingOwner_;
    }

    function setAllowed(address target, bool allowed) external {
        isAllowed[target] = allowed;
    }
}

contract AtomicSeedPermit2Mock is IOzSeedPermit2 {
    function allowance(address, address, address)
        external
        pure
        returns (uint160 amount, uint48 expiration, uint48 nonce)
    {
        return (0, 0, 0);
    }
}

contract AtomicSeedQuoterMock is IOzSeedV4Quoter {
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    uint256 public quotedAeweth;
    uint256 public quotedUsdG;
    uint256 public quoteCalls;

    function configure(uint256 quotedAeweth_, uint256 quotedUsdG_) external {
        quotedAeweth = quotedAeweth_;
        quotedUsdG = quotedUsdG_;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut, uint256 gasEstimate)
    {
        ++quoteCalls;
        if (quoteCalls == 1) {
            require(params.poolKey.currency0 == AEWETH && params.poolKey.currency1 == ZAPS, "first pool");
            require(!params.zeroForOne && uint256(params.exactAmount) == 65_000 ether, "first quote");
            return (quotedAeweth, 0);
        }
        require(quoteCalls == 2, "too many quotes");
        require(params.poolKey.currency0 == AEWETH && params.poolKey.currency1 == USDG, "second pool");
        require(params.zeroForOne && uint256(params.exactAmount) == quotedAeweth, "second quote");
        return (quotedUsdG, 0);
    }
}

contract AtomicSeedRouteMock is IOzSeedRouteAdapter {
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant OZ_USDG = 0xeAD10C998c59745a030FfAc9209b294C14C7D325;
    address internal constant ZAPS_HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;
    bytes32 internal constant ZAPS_POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;
    bytes32 internal constant USDG_POOL_ID = 0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2;

    uint256 public amountOut;
    uint256 public executeCalls;
    bool public donateToVault;
    bool public routeDrift;

    function configure(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    function setDonateToVault(bool enabled) external {
        donateToVault = enabled;
    }

    function setRouteDrift(bool enabled) external {
        routeDrift = enabled;
    }

    function universalRouter() external view returns (address) {
        if (routeDrift) return address(0xDEAD);
        return UNIVERSAL_ROUTER;
    }

    function permit2() external pure returns (address) {
        return PERMIT2;
    }

    function route() external pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = ZAPS;
        path[1] = AEWETH;
        path[2] = USDG;
    }

    function hopCount() external pure returns (uint256) {
        return 2;
    }

    function hop(uint256 index) external pure returns (PoolKey memory) {
        if (index == 0) {
            return PoolKey({currency0: AEWETH, currency1: ZAPS, fee: 0x800000, tickSpacing: 200, hooks: ZAPS_HOOK});
        }
        require(index == 1, "bad hop");
        return PoolKey({currency0: AEWETH, currency1: USDG, fee: 450, tickSpacing: 9, hooks: address(0)});
    }

    function poolId(uint256 index) external pure returns (bytes32) {
        if (index == 0) return ZAPS_POOL_ID;
        require(index == 1, "bad pool");
        return USDG_POOL_ID;
    }

    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        returns (address tokenOut, uint256 measuredAmountOut)
    {
        ++executeCalls;
        require(tokenIn == ZAPS && amountIn == 65_000 ether, "wrong input");
        require(abi.decode(data, (uint256)) <= amountOut, "floor too high");
        require(AtomicSeedTokenMock(ZAPS).transferFrom(msg.sender, address(this), amountIn), "pull");
        AtomicSeedTokenMock(ZAPS).burn(address(this), amountIn);
        AtomicSeedTokenMock(USDG).mint(msg.sender, amountOut);
        if (donateToVault) AtomicSeedTokenMock(USDG).mint(OZ_USDG, 1);
        return (USDG, amountOut);
    }
}

contract AtomicSeedVaultMock {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    uint256 public totalSupply;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;
    uint256 public depositCalls;

    function asset() external pure returns (address) {
        return USDG;
    }

    function decimals() external pure returns (uint8) {
        return 9;
    }

    function totalAssets() external view returns (uint256) {
        return AtomicSeedTokenMock(USDG).balanceOf(address(this));
    }

    function forceShareBalance(address account, uint256 amount) external {
        balanceOf[account] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient shares");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        ++depositCalls;
        uint256 assetsBefore = AtomicSeedTokenMock(USDG).balanceOf(address(this));
        shares = assets * (totalSupply + 1_000) / (assetsBefore + 1);
        require(AtomicSeedTokenMock(USDG).transferFrom(msg.sender, address(this), assets), "pull");
        totalSupply += shares;
        balanceOf[receiver] += shares;
    }
}

contract AtomicSeederHarness is OzUSDGAtomicSeeder {
    function _expectedRouteAdapterCodeHash() internal view override returns (bytes32) {
        return ROUTE_ADAPTER.codehash;
    }

    function _expectedVaultCodeHash() internal view override returns (bytes32) {
        return OZ_USDG.codehash;
    }
}

contract AtomicSeedScriptHarness is SeedOzUSDGRobinhood {
    function _deployHelper() internal override returns (OzUSDGAtomicSeeder helper) {
        helper = new AtomicSeederHarness();
    }

    function _expectedHelperRuntimeCodeHash() internal pure override returns (bytes32) {
        return keccak256(type(AtomicSeederHarness).runtimeCode);
    }

    function _expectedV4QuoterCodeHash() internal view override returns (bytes32) {
        return V4_QUOTER.codehash;
    }
}

contract AtomicSeedScriptOwnerCaller {
    function run(SeedOzUSDGRobinhood seed) external returns (SeedOzUSDGRobinhood.Result memory) {
        return seed.run();
    }
}

contract SeedOzUSDGRobinhoodTest is Test {
    uint256 internal constant OWNER_USDG_INPUT = 946_460;
    uint256 internal constant QUOTED_AEWETH = 28_760_364_065_631;
    uint256 internal constant QUOTED_USDG = 54_990;
    uint256 internal constant MINIMUM_USDG = 54_440;

    address internal constant OWNER = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address internal constant OTHER = address(0xBEEF);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant ADAPTER_REGISTRY = 0x9E56e444f490C00A6277326A47Cb462E12dF1f17;
    address internal constant TOKEN_ALLOWLIST = 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B;
    address internal constant ROUTE_ADAPTER = 0x9C3F7F057aC3d2828C7271ba73538B33E32E7a59;
    address internal constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant OZ_USDG = 0xeAD10C998c59745a030FfAc9209b294C14C7D325;
    address internal constant ZAPS_HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;

    function setUp() public {
        vm.chainId(4663);
        _installMocks();
        _configureHappyPath();
    }

    function test_scriptRecordsAtomicFourTransactionShapeAndSucceeds() public {
        AtomicSeedScriptHarness script = new AtomicSeedScriptHarness();
        SeedOzUSDGRobinhood.Result memory result = AtomicSeedScriptOwnerCaller(OWNER).run(script);
        OzUSDGAtomicSeeder helper = result.helper;

        assertTrue(helper.seeded());
        assertEq(result.ownerUsdGBefore, OWNER_USDG_INPUT);
        assertEq(result.ownerUsdGInput, OWNER_USDG_INPUT);
        assertEq(result.minimumUsdG, MINIMUM_USDG);
        assertEq(result.atomic.measuredSwapOutput, QUOTED_USDG);
        assertEq(result.atomic.seedShares, 1_000_000_000);
        assertEq(result.atomic.refundedUsdG, 1_450);
        assertEq(AtomicSeedQuoterMock(V4_QUOTER).quoteCalls(), 2);
        assertEq(AtomicSeedTokenMock(ZAPS).approveCallsByOwner(OWNER), 1);
        assertEq(AtomicSeedTokenMock(USDG).approveCallsByOwner(OWNER), 1);
        assertEq(AtomicSeedTokenMock(ZAPS).approveCallsByOwner(address(helper)), 1);
        assertEq(AtomicSeedTokenMock(USDG).approveCallsByOwner(address(helper)), 1);
        assertEq(AtomicSeedRouteMock(ROUTE_ADAPTER).executeCalls(), 1);
        assertEq(AtomicSeedVaultMock(OZ_USDG).depositCalls(), 1);
        _assertSuccessState(helper, 1_450);
    }

    function test_scriptLeavesExtraOwnerUsdGUntouched() public {
        AtomicSeedTokenMock(USDG).mint(OWNER, 100_000);
        AtomicSeedScriptHarness script = new AtomicSeedScriptHarness();
        SeedOzUSDGRobinhood.Result memory result = AtomicSeedScriptOwnerCaller(OWNER).run(script);

        assertEq(result.ownerUsdGBefore, OWNER_USDG_INPUT + 100_000);
        assertEq(result.ownerUsdGInput, OWNER_USDG_INPUT);
        assertEq(result.shortfall, 53_540);
        assertEq(result.atomic.ownerUsdGInput, OWNER_USDG_INPUT);
        assertEq(AtomicSeedTokenMock(USDG).balanceOf(OWNER), 101_450);
        assertEq(AtomicSeedTokenMock(USDG).allowance(OWNER, address(result.helper)), 0);
    }

    function test_vaultDonationBeforeFinalCallRevertsBeforePulls() public {
        AtomicSeederHarness helper = _deployAndApprove();
        AtomicSeedTokenMock(USDG).mint(OZ_USDG, 1);

        uint256 zapsBefore = AtomicSeedTokenMock(ZAPS).balanceOf(OWNER);
        uint256 usdGBefore = AtomicSeedTokenMock(USDG).balanceOf(OWNER);
        vm.expectRevert(abi.encodeWithSelector(OzUSDGAtomicSeeder.VaultNotEmpty.selector, 0, 1, 0));
        vm.prank(OWNER);
        helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);

        assertEq(AtomicSeedTokenMock(ZAPS).balanceOf(OWNER), zapsBefore);
        assertEq(AtomicSeedTokenMock(USDG).balanceOf(OWNER), usdGBefore);
        assertEq(AtomicSeedTokenMock(ZAPS).allowance(OWNER, address(helper)), 65_000 ether);
        assertEq(AtomicSeedTokenMock(USDG).allowance(OWNER, address(helper)), OWNER_USDG_INPUT);
        assertFalse(helper.seeded());
    }

    function test_routeSideEffectDonationHitsSecondEmptyVaultCheckAndUnwinds() public {
        AtomicSeederHarness helper = _deployAndApprove();
        AtomicSeedRouteMock(ROUTE_ADAPTER).setDonateToVault(true);

        uint256 zapsBefore = AtomicSeedTokenMock(ZAPS).balanceOf(OWNER);
        uint256 usdGBefore = AtomicSeedTokenMock(USDG).balanceOf(OWNER);
        vm.expectRevert(abi.encodeWithSelector(OzUSDGAtomicSeeder.VaultNotEmpty.selector, 0, 1, 0));
        vm.prank(OWNER);
        helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);

        assertEq(AtomicSeedTokenMock(ZAPS).balanceOf(OWNER), zapsBefore);
        assertEq(AtomicSeedTokenMock(USDG).balanceOf(OWNER), usdGBefore);
        assertEq(AtomicSeedTokenMock(USDG).balanceOf(OZ_USDG), 0);
        assertFalse(helper.seeded());
    }

    function test_helperPrefundingIsExcludedAndRefundedAcrossAllPinnedTokens() public {
        AtomicSeederHarness helper = new AtomicSeederHarness();
        AtomicSeedTokenMock(ZAPS).mint(address(helper), 11 ether);
        AtomicSeedTokenMock(AEWETH).mint(address(helper), 22);
        AtomicSeedTokenMock(USDG).mint(address(helper), 33);
        AtomicSeedVaultMock(OZ_USDG).forceShareBalance(address(helper), 44);
        _approve(helper, OWNER_USDG_INPUT);

        vm.prank(OWNER);
        OzUSDGAtomicSeeder.Result memory result = helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);

        assertEq(result.refundedZaps, 11 ether);
        assertEq(result.refundedAeweth, 22);
        assertEq(result.refundedUsdG, 1_483);
        assertEq(result.refundedOzUsdG, 44);
        _assertSuccessState(helper, 1_483);
        assertEq(AtomicSeedTokenMock(AEWETH).balanceOf(OWNER), 22);
        assertEq(AtomicSeedVaultMock(OZ_USDG).balanceOf(OWNER), 44);
    }

    function test_ownerUsdGDonationAfterApprovalDoesNotExpandThePull() public {
        AtomicSeederHarness helper = _deployAndApprove();
        AtomicSeedTokenMock(USDG).mint(OWNER, 7);

        vm.prank(OWNER);
        OzUSDGAtomicSeeder.Result memory result = helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);

        assertEq(result.ownerUsdGBefore, OWNER_USDG_INPUT + 7);
        assertEq(result.ownerUsdGInput, OWNER_USDG_INPUT);
        assertEq(result.refundedUsdG, 1_450);
        assertEq(AtomicSeedTokenMock(USDG).balanceOf(OWNER), 1_457);
    }

    function test_reentrantTokenCallbackIsBlockedWithoutBreakingSeed() public {
        AtomicSeederHarness helper = _deployAndApprove();
        AtomicSeedTokenMock(USDG)
            .configureCallback(
                address(helper), abi.encodeCall(OzUSDGAtomicSeeder.seed, (OWNER_USDG_INPUT, MINIMUM_USDG))
            );

        vm.prank(OWNER);
        helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);

        assertEq(AtomicSeedTokenMock(USDG).callbackAttempts(), 1);
        assertEq(AtomicSeedTokenMock(USDG).callbackRevertSelector(), OzUSDGAtomicSeeder.Reentrancy.selector);
        assertTrue(helper.seeded());
    }

    function test_successfulHelperIsOneShot() public {
        AtomicSeederHarness helper = _deployAndApprove();
        vm.prank(OWNER);
        helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);

        vm.expectRevert(OzUSDGAtomicSeeder.AlreadySeeded.selector);
        vm.prank(OWNER);
        helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);
    }

    function test_productionHelperRejectsMockRouteCodehash() public {
        vm.expectRevert();
        new OzUSDGAtomicSeeder();
    }

    function test_constructorRejectsUnallowlistedAdapter() public {
        AtomicSeedRegistryMock(ADAPTER_REGISTRY).setAllowed(ROUTE_ADAPTER, false);
        vm.expectRevert(abi.encodeWithSelector(OzUSDGAtomicSeeder.AdapterNotAllowed.selector, ROUTE_ADAPTER));
        new AtomicSeederHarness();
    }

    function test_constructorRejectsUnallowlistedToken() public {
        AtomicSeedRegistryMock(TOKEN_ALLOWLIST).setAllowed(USDG, false);
        vm.expectRevert(abi.encodeWithSelector(OzUSDGAtomicSeeder.TokenNotAllowed.selector, USDG));
        new AtomicSeederHarness();
    }

    function test_constructorRejectsRoutePinDrift() public {
        AtomicSeedRouteMock(ROUTE_ADAPTER).setRouteDrift(true);
        vm.expectRevert(abi.encodeWithSelector(OzUSDGAtomicSeeder.RoutePinMismatch.selector, bytes32("ROUTER")));
        new AtomicSeederHarness();
    }

    function test_seedRejectsNonExactZapsAllowanceBeforePulls() public {
        AtomicSeederHarness helper = _deployAndApprove();
        vm.prank(OWNER);
        AtomicSeedTokenMock(ZAPS).approve(address(helper), 65_000 ether + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                OzUSDGAtomicSeeder.AllowanceMismatch.selector,
                ZAPS,
                OWNER,
                address(helper),
                65_000 ether + 1,
                65_000 ether
            )
        );
        vm.prank(OWNER);
        helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);

        assertEq(AtomicSeedTokenMock(ZAPS).balanceOf(OWNER), 100_000 ether);
        assertEq(AtomicSeedTokenMock(USDG).balanceOf(OWNER), OWNER_USDG_INPUT);
        assertFalse(helper.seeded());
    }

    function test_seedRejectsNonExactUsdGAllowanceBeforePulls() public {
        AtomicSeederHarness helper = _deployAndApprove();
        vm.prank(OWNER);
        AtomicSeedTokenMock(USDG).approve(address(helper), OWNER_USDG_INPUT - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                OzUSDGAtomicSeeder.AllowanceMismatch.selector,
                USDG,
                OWNER,
                address(helper),
                OWNER_USDG_INPUT - 1,
                OWNER_USDG_INPUT
            )
        );
        vm.prank(OWNER);
        helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);

        assertEq(AtomicSeedTokenMock(ZAPS).balanceOf(OWNER), 100_000 ether);
        assertEq(AtomicSeedTokenMock(USDG).balanceOf(OWNER), OWNER_USDG_INPUT);
        assertFalse(helper.seeded());
    }

    function test_seedRejectsMinimumBelowShortfallBeforePulls() public {
        AtomicSeederHarness helper = _deployAndApprove();
        uint256 shortfall = 1_000_000 - OWNER_USDG_INPUT;

        vm.expectRevert(
            abi.encodeWithSelector(OzUSDGAtomicSeeder.MinimumDoesNotCoverShortfall.selector, shortfall - 1, shortfall)
        );
        vm.prank(OWNER);
        helper.seed(OWNER_USDG_INPUT, shortfall - 1);

        assertEq(AtomicSeedTokenMock(ZAPS).balanceOf(OWNER), 100_000 ether);
        assertEq(AtomicSeedTokenMock(USDG).balanceOf(OWNER), OWNER_USDG_INPUT);
        assertFalse(helper.seeded());
    }

    function test_seedRejectsInsufficientOwnerZapsBalanceBeforePulls() public {
        AtomicSeederHarness helper = _deployAndApprove();
        AtomicSeedTokenMock(ZAPS).burn(OWNER, 35_000 ether + 1);
        uint256 remaining = 65_000 ether - 1;

        vm.expectRevert(
            abi.encodeWithSelector(OzUSDGAtomicSeeder.OwnerBalanceInsufficient.selector, ZAPS, remaining, 65_000 ether)
        );
        vm.prank(OWNER);
        helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);

        assertEq(AtomicSeedTokenMock(USDG).balanceOf(OWNER), OWNER_USDG_INPUT);
        assertFalse(helper.seeded());
    }

    function test_seedRejectsInsufficientOwnerUsdGBalanceBeforePulls() public {
        AtomicSeederHarness helper = _deployAndApprove();
        AtomicSeedTokenMock(USDG).burn(OWNER, 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                OzUSDGAtomicSeeder.OwnerBalanceInsufficient.selector, USDG, OWNER_USDG_INPUT - 1, OWNER_USDG_INPUT
            )
        );
        vm.prank(OWNER);
        helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);

        assertEq(AtomicSeedTokenMock(ZAPS).balanceOf(OWNER), 100_000 ether);
        assertFalse(helper.seeded());
    }

    function test_helperRejectsWrongCallerBeforePulls() public {
        AtomicSeederHarness helper = _deployAndApprove();
        vm.expectRevert(abi.encodeWithSelector(OzUSDGAtomicSeeder.WrongCaller.selector, OTHER, OWNER));
        vm.prank(OTHER);
        helper.seed(OWNER_USDG_INPUT, MINIMUM_USDG);
    }

    function test_scriptRejectsWrongChainAndOwner() public {
        AtomicSeedScriptHarness script = new AtomicSeedScriptHarness();
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(SeedOzUSDGRobinhood.WrongChain.selector, 1));
        vm.prank(OWNER);
        script.run();

        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(SeedOzUSDGRobinhood.WrongOwner.selector, OTHER, OWNER));
        vm.prank(OTHER);
        script.run();
    }

    function test_scriptRejectsUnpinnedQuoterRuntimeBeforeQuote() public {
        SeedOzUSDGRobinhood script = new SeedOzUSDGRobinhood();
        bytes32 actual = V4_QUOTER.codehash;
        vm.expectRevert(
            abi.encodeWithSelector(
                SeedOzUSDGRobinhood.CodeHashMismatch.selector, V4_QUOTER, actual, script.V4_QUOTER_RUNTIME_CODEHASH()
            )
        );
        AtomicSeedScriptOwnerCaller(OWNER).run(script);

        assertEq(AtomicSeedQuoterMock(V4_QUOTER).quoteCalls(), 0);
    }

    function _deployAndApprove() internal returns (AtomicSeederHarness helper) {
        helper = new AtomicSeederHarness();
        _approve(helper, OWNER_USDG_INPUT);
    }

    function _approve(OzUSDGAtomicSeeder helper, uint256 usdGInput) internal {
        vm.startPrank(OWNER);
        AtomicSeedTokenMock(ZAPS).approve(address(helper), 65_000 ether);
        AtomicSeedTokenMock(USDG).approve(address(helper), usdGInput);
        vm.stopPrank();
    }

    function _assertSuccessState(OzUSDGAtomicSeeder helper, uint256 ownerUsdG) internal view {
        assertEq(AtomicSeedTokenMock(ZAPS).allowance(OWNER, address(helper)), 0);
        assertEq(AtomicSeedTokenMock(USDG).allowance(OWNER, address(helper)), 0);
        assertEq(AtomicSeedTokenMock(ZAPS).balanceOf(address(helper)), 0);
        assertEq(AtomicSeedTokenMock(AEWETH).balanceOf(address(helper)), 0);
        assertEq(AtomicSeedTokenMock(USDG).balanceOf(address(helper)), 0);
        assertEq(AtomicSeedVaultMock(OZ_USDG).balanceOf(address(helper)), 0);
        assertEq(AtomicSeedTokenMock(USDG).balanceOf(OWNER), ownerUsdG);
        assertEq(AtomicSeedVaultMock(OZ_USDG).totalAssets(), 1_000_000);
        assertEq(AtomicSeedVaultMock(OZ_USDG).totalSupply(), 1_000_000_000);
        assertEq(AtomicSeedVaultMock(OZ_USDG).balanceOf(DEAD), 1_000_000_000);
    }

    function _installMocks() internal {
        AtomicSeedTokenMock tokenTemplate = new AtomicSeedTokenMock();
        vm.etch(AEWETH, address(tokenTemplate).code);
        vm.etch(ZAPS, address(tokenTemplate).code);
        vm.etch(USDG, address(tokenTemplate).code);

        AtomicSeedRegistryMock registryTemplate = new AtomicSeedRegistryMock();
        vm.etch(ADAPTER_REGISTRY, address(registryTemplate).code);
        vm.etch(TOKEN_ALLOWLIST, address(registryTemplate).code);

        AtomicSeedPermit2Mock permit2Template = new AtomicSeedPermit2Mock();
        vm.etch(PERMIT2, address(permit2Template).code);
        AtomicSeedQuoterMock quoterTemplate = new AtomicSeedQuoterMock();
        vm.etch(V4_QUOTER, address(quoterTemplate).code);
        AtomicSeedRouteMock routeTemplate = new AtomicSeedRouteMock();
        vm.etch(ROUTE_ADAPTER, address(routeTemplate).code);
        AtomicSeedVaultMock vaultTemplate = new AtomicSeedVaultMock();
        vm.etch(OZ_USDG, address(vaultTemplate).code);
        AtomicSeedScriptOwnerCaller callerTemplate = new AtomicSeedScriptOwnerCaller();
        vm.etch(OWNER, address(callerTemplate).code);

        vm.etch(UNIVERSAL_ROUTER, hex"00");
        vm.etch(ZAPS_HOOK, hex"00");
    }

    function _configureHappyPath() internal {
        AtomicSeedRegistryMock(ADAPTER_REGISTRY).configureOwner(OWNER, address(0));
        AtomicSeedRegistryMock(ADAPTER_REGISTRY).setAllowed(ROUTE_ADAPTER, true);
        AtomicSeedRegistryMock(TOKEN_ALLOWLIST).configureOwner(OWNER, address(0));
        AtomicSeedRegistryMock(TOKEN_ALLOWLIST).setAllowed(AEWETH, true);
        AtomicSeedRegistryMock(TOKEN_ALLOWLIST).setAllowed(ZAPS, true);
        AtomicSeedRegistryMock(TOKEN_ALLOWLIST).setAllowed(USDG, true);
        AtomicSeedRegistryMock(TOKEN_ALLOWLIST).setAllowed(OZ_USDG, true);
        AtomicSeedQuoterMock(V4_QUOTER).configure(QUOTED_AEWETH, QUOTED_USDG);
        AtomicSeedRouteMock(ROUTE_ADAPTER).configure(QUOTED_USDG);
        AtomicSeedTokenMock(ZAPS).mint(OWNER, 100_000 ether);
        AtomicSeedTokenMock(USDG).mint(OWNER, OWNER_USDG_INPUT);
    }
}
