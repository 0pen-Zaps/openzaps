// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {SafeApprove} from "../src/libraries/SafeApprove.sol";
import {AaveV3SupplyAdapter} from "../src/adapters/AaveV3SupplyAdapter.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

interface IERC20Live {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IWETHLive is IERC20Live {
    function deposit() external payable;
}

interface IPoolLive {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
    function getReserveAToken(address asset) external view returns (address);
    function getReserveVariableDebtToken(address asset) external view returns (address);
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

interface IVariableDebtTokenLive {
    function approveDelegation(address delegatee, uint256 amount) external;
    function borrowAllowance(address fromUser, address toUser) external view returns (uint256);
    function balanceOf(address user) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev A stand-in Pool that re-enters the adapter from inside `supply`. Doubles as its own aToken so
///      the adapter's constructor wiring (`getReserveAToken` / `UNDERLYING_ASSET_ADDRESS`) is satisfied.
contract ReentrantAavePool {
    address public immutable underlying;
    address public adapter;

    constructor(address underlying_) {
        underlying = underlying_;
    }

    function setAdapter(address adapter_) external {
        adapter = adapter_;
    }

    function getReserveAToken(address) external view returns (address) {
        return address(this);
    }

    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return underlying;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function supply(address, uint256 amount, address, uint16) external {
        AaveV3SupplyAdapter(adapter).execute(underlying, amount, "");
    }
}

/// @title AaveV3AdaptersForkTest
/// @notice Base-mainnet fork proof for `AaveV3SupplyAdapter`, plus the tests that establish the
///         negative result documented in `src/adapters/AaveV3BorrowAdapter.sol`: an OpenZap clone can
///         hold an Aave position, but no adapter can ever borrow against it.
/// @dev Runs when the suite is already forked (`forge test --fork-url https://mainnet.base.org`) and
///      opts in via `RUN_BASE_FORK=true` otherwise. Skips (never silently passes) with no fork.
contract AaveV3AdaptersForkTest is Test {
    uint256 internal constant BASE_CHAIN_ID = 8453;
    /// @dev Same block the other Base fork suites and `foundry.toml` pin.
    uint256 internal constant FORK_BLOCK = 48_900_000;

    address internal constant POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    bool internal forked;
    address internal aWETH;
    address internal vdUSDC;

    AdapterRegistry internal registry;
    TokenAllowlist internal allowlist;
    OpenZapFactory internal factory;
    AaveV3SupplyAdapter internal supplyAdapter;

    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;

    function setUp() public {
        // Always create this suite's OWN fork at a pinned block, exactly like
        // `test/BaseV3SwapAdapter.fork.t.sol`, and never inherit an ambient `--fork-url`. Three
        // reasons, all learned the hard way:
        //   1. No silent skip. This suite used to return early (reporting a green it had not earned)
        //      unless RUN_BASE_FORK was set. Now it either runs against real Aave or it fails loudly.
        //   2. Determinism. Aave rates, caps and the reserve's aToken all move with the head block.
        //   3. Foundry only writes its RPC disk cache for a PINNED block. Inheriting an unpinned
        //      ambient fork means re-fetching every Pool slot on every run, which a public endpoint
        //      answers with HTTP 429 — a fake failure that says nothing about the adapter.
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")), FORK_BLOCK);
        forked = true;

        // Never trust an address we did not check against the live chain.
        assertGt(POOL.code.length, 0, "no Aave v3 Pool at the pinned address");
        aWETH = IPoolLive(POOL).getReserveAToken(WETH);
        vdUSDC = IPoolLive(POOL).getReserveVariableDebtToken(USDC);
        assertGt(aWETH.code.length, 0, "no aWETH");
        assertGt(vdUSDC.code.length, 0, "no variable-debt USDC");

        registry = new AdapterRegistry(address(this));
        allowlist = new TokenAllowlist(address(this));
        factory = new OpenZapFactory(registry, allowlist);
        supplyAdapter = new AaveV3SupplyAdapter(POOL, WETH);

        registry.setAdapter(address(supplyAdapter), true);
        allowlist.setToken(WETH, true);
        allowlist.setToken(aWETH, true);
        allowlist.setToken(USDC, true);

        owner = vm.addr(OWNER_PK);
    }

    function _skipUnlessForked() internal returns (bool ok) {
        if (!forked) {
            vm.skip(true);
            return false;
        }
        return true;
    }

    function _fundWeth(address to, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        IWETHLive(WETH).deposit{value: amount}();
        IERC20Live(WETH).transfer(to, amount);
    }

    // ------------------------------------------------------------------ //
    // Supply: the clean case                                             //
    // ------------------------------------------------------------------ //

    /// @notice The aToken lands on the CALLER, not on the adapter, and the adapter keeps nothing.
    function test_supply_aTokenLandsOnCallerNotAdapter() public {
        if (!_skipUnlessForked()) return;

        address zap = makeAddr("aave-supply-caller");
        uint256 amountIn = 1 ether;
        _fundWeth(zap, amountIn);

        assertEq(supplyAdapter.aToken(), aWETH);
        uint256 callerBefore = IERC20Live(aWETH).balanceOf(zap);

        vm.startPrank(zap);
        IERC20Live(WETH).approve(address(supplyAdapter), amountIn);
        (address tokenOut, uint256 amountOut) = supplyAdapter.execute(WETH, amountIn, "");
        vm.stopPrank();

        assertEq(tokenOut, aWETH, "tokenOut must be the reserve aToken");
        assertApproxEqAbs(amountOut, amountIn, 1, "measured aToken delta ~= amountIn (ray round-trip)");
        assertEq(IERC20Live(aWETH).balanceOf(zap) - callerBefore, amountOut, "adapter must report what it measured");

        // The adapter is a pass-through: no aToken, no underlying, no allowance left anywhere.
        assertEq(IERC20Live(aWETH).balanceOf(address(supplyAdapter)), 0, "adapter holds aToken");
        assertEq(IERC20Live(WETH).balanceOf(address(supplyAdapter)), 0, "adapter holds underlying");
        assertEq(IERC20Live(WETH).allowance(address(supplyAdapter), POOL), 0, "residual pool allowance");
        assertEq(IERC20Live(WETH).allowance(zap, address(supplyAdapter)), 0, "caller allowance not consumed");
    }

    /// @notice Aave account data moves for the CALLER: collateral rises, and with no debt the health
    ///         factor is uint256.max both before and after.
    function test_supply_creditsCallerAccountAndHealthFactor() public {
        if (!_skipUnlessForked()) return;

        address zap = makeAddr("aave-supply-account");
        uint256 amountIn = 2 ether;
        _fundWeth(zap, amountIn);

        (uint256 collBefore, uint256 debtBefore,,,, uint256 hfBefore) = IPoolLive(POOL).getUserAccountData(zap);
        assertEq(collBefore, 0);
        assertEq(debtBefore, 0);
        assertEq(hfBefore, type(uint256).max, "no debt => infinite health factor");

        vm.startPrank(zap);
        IERC20Live(WETH).approve(address(supplyAdapter), amountIn);
        supplyAdapter.execute(WETH, amountIn, "");
        vm.stopPrank();

        (uint256 collAfter, uint256 debtAfter, uint256 borrowableAfter,,, uint256 hfAfter) =
            IPoolLive(POOL).getUserAccountData(zap);
        assertGt(collAfter, collBefore, "supply must credit the caller's collateral");
        assertEq(debtAfter, 0);
        assertGt(borrowableAfter, 0, "collateral must be usable as collateral");
        assertEq(hfAfter, type(uint256).max);

        // Nothing was credited to the adapter's own Aave account.
        (uint256 adapterColl,,,,,) = IPoolLive(POOL).getUserAccountData(address(supplyAdapter));
        assertEq(adapterColl, 0, "adapter must never become the Aave account holder");
    }

    /// @notice Supplying against an existing debt position raises the caller's health factor. This
    ///         also demonstrates that the health factor of the SAME address is what the adapter moves.
    function test_supply_raisesHealthFactorOfAnIndebtedCaller() public {
        if (!_skipUnlessForked()) return;

        address zap = makeAddr("aave-supply-indebted");
        _fundWeth(zap, 3 ether);

        // Seed a real borrow position by acting as the zap directly (see the borrow tests for why an
        // adapter cannot do this).
        vm.startPrank(zap);
        IERC20Live(WETH).approve(POOL, 1 ether);
        IPoolLive(POOL).supply(WETH, 1 ether, zap, 0);
        IPoolLive(POOL).borrow(USDC, 500e6, 2, 0, zap);
        vm.stopPrank();

        (, uint256 debtBefore,,,, uint256 hfBefore) = IPoolLive(POOL).getUserAccountData(zap);
        assertGt(debtBefore, 0, "expected a live debt position");
        assertLt(hfBefore, type(uint256).max);
        assertGt(hfBefore, 1e18, "seeded position must be healthy");

        vm.startPrank(zap);
        IERC20Live(WETH).approve(address(supplyAdapter), 2 ether);
        (, uint256 amountOut) = supplyAdapter.execute(WETH, 2 ether, "");
        vm.stopPrank();

        (,,,,, uint256 hfAfter) = IPoolLive(POOL).getUserAccountData(zap);
        assertGt(hfAfter, hfBefore, "supplying collateral must improve the health factor");
        assertGt(amountOut, 0);
        assertEq(IERC20Live(aWETH).balanceOf(address(supplyAdapter)), 0);
    }

    /// @notice End-to-end through a real OpenZap clone: the aToken delta is what `execute()` settles.
    function test_supply_settlesThroughOpenZap() public {
        if (!_skipUnlessForked()) return;

        uint256 amountIn = 1 ether;

        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(supplyAdapter),
            tokenIn: WETH,
            spender: address(supplyAdapter),
            amountIn: amountIn,
            data: ""
        });
        address[] memory tracked = new address[](2);
        tracked[0] = WETH;
        tracked[1] = aWETH;
        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });

        address zapAddress = factory.createZap(policy, keccak256("aave-supply-zap"));
        OpenZap zap = OpenZap(payable(zapAddress));
        _fundWeth(zapAddress, amountIn);

        // A min-out above what Aave can mint must fail, and must not burn the nonce.
        OpenZapIntent memory intent = _intent(zap, owner, aWETH, amountIn + 1e18);
        bytes memory tooGreedy = _sign(zap, intent, OWNER_PK);
        vm.expectRevert(OpenZap.MinOutNotMet.selector);
        zap.execute(intent, tooGreedy);
        assertFalse(zap.nonceUsed(0));
        assertEq(IERC20Live(WETH).balanceOf(zapAddress), amountIn);

        intent.minOut = amountIn - 1; // ray round-trip tolerance
        bytes memory sig = _sign(zap, intent, OWNER_PK);
        zap.execute(intent, sig);

        assertTrue(zap.nonceUsed(0));
        assertApproxEqAbs(IERC20Live(aWETH).balanceOf(owner), amountIn, 2, "recipient receives the aToken");
        assertEq(IERC20Live(WETH).balanceOf(zapAddress), 0, "no underlying dust in the zap");
        assertEq(IERC20Live(aWETH).balanceOf(zapAddress), 0, "no aToken dust in the zap");
        assertEq(IERC20Live(WETH).allowance(zapAddress, address(supplyAdapter)), 0, "residual step allowance");
        assertEq(IERC20Live(WETH).balanceOf(address(supplyAdapter)), 0);
        assertEq(IERC20Live(aWETH).balanceOf(address(supplyAdapter)), 0);
    }

    /// @notice The adapter's refusals: wrong token, any data at all, zero amount, wrong chain.
    function test_supply_refusals() public {
        if (!_skipUnlessForked()) return;

        address zap = makeAddr("aave-supply-refusals");
        _fundWeth(zap, 1 ether);
        vm.startPrank(zap);
        IERC20Live(WETH).approve(address(supplyAdapter), 1 ether);

        vm.expectRevert(abi.encodeWithSelector(AaveV3SupplyAdapter.UnsupportedToken.selector, USDC));
        supplyAdapter.execute(USDC, 1 ether, "");

        vm.expectRevert(AaveV3SupplyAdapter.UnexpectedData.selector);
        supplyAdapter.execute(WETH, 1 ether, hex"00");

        vm.expectRevert(AaveV3SupplyAdapter.ZeroAmount.selector);
        supplyAdapter.execute(WETH, 0, "");
        vm.stopPrank();

        vm.chainId(1);
        vm.prank(zap);
        vm.expectRevert(abi.encodeWithSelector(AaveV3SupplyAdapter.WrongChain.selector, uint256(1)));
        supplyAdapter.execute(WETH, 1 ether, "");
        vm.chainId(BASE_CHAIN_ID);

        // Nothing moved on any refusal path.
        assertEq(IERC20Live(WETH).balanceOf(zap), 1 ether);
        assertEq(IERC20Live(WETH).balanceOf(address(supplyAdapter)), 0);
    }

    /// @notice A Pool that calls back into the adapter from inside `supply` is stopped by the guard.
    function test_supply_reentrancyGuardBlocksAMaliciousPool() public {
        if (!_skipUnlessForked()) return;

        MockERC20 underlying = new MockERC20("Mock", "MCK", 18);
        ReentrantAavePool evilPool = new ReentrantAavePool(address(underlying));
        AaveV3SupplyAdapter evilAdapter = new AaveV3SupplyAdapter(address(evilPool), address(underlying));
        evilPool.setAdapter(address(evilAdapter));

        address zap = makeAddr("aave-reentrancy-caller");
        underlying.mint(zap, 10 ether);
        vm.startPrank(zap);
        underlying.approve(address(evilAdapter), 10 ether);
        vm.expectRevert(AaveV3SupplyAdapter.Reentrancy.selector);
        evilAdapter.execute(address(underlying), 1 ether, "");
        vm.stopPrank();

        assertEq(underlying.balanceOf(address(evilAdapter)), 0);
        assertEq(underlying.balanceOf(zap), 10 ether);
    }

    // ------------------------------------------------------------------ //
    // Borrow: the negative result                                        //
    // ------------------------------------------------------------------ //

    /// @notice Aave itself has no objection to an OpenZap clone as an account holder: the clone can
    ///         supply and borrow — but only when the CLONE is `msg.sender` to the Pool. OpenZap has no
    ///         code path that makes a clone call `Pool.borrow`, so this is unreachable in production.
    ///         This test exists to locate the blocker precisely: it is OpenZap's call surface, not Aave.
    function test_borrow_aaveAllowsAZapAccountOnlyWhenTheZapItselfCallsThePool() public {
        if (!_skipUnlessForked()) return;

        address zapAddress = _deploySupplyZap("aave-borrow-account");
        _fundWeth(zapAddress, 1 ether);

        vm.startPrank(zapAddress);
        IERC20Live(WETH).approve(POOL, 1 ether);
        IPoolLive(POOL).supply(WETH, 1 ether, zapAddress, 0);
        IPoolLive(POOL).borrow(USDC, 100e6, 2, 0, zapAddress);
        vm.stopPrank();

        assertEq(IERC20Live(USDC).balanceOf(zapAddress), 100e6, "borrowed asset lands on the borrower");
        assertGt(IVariableDebtTokenLive(vdUSDC).balanceOf(zapAddress), 0, "debt opens on the borrower");
        (,,,,, uint256 hf) = IPoolLive(POOL).getUserAccountData(zapAddress);
        assertLt(hf, type(uint256).max);
        assertGt(hf, 1e18);
    }

    /// @notice An adapter calling `borrow(..., onBehalfOf: zap)` is rejected by Aave without credit
    ///         delegation. This is the wall the borrow adapter would hit on its very first call.
    function test_borrow_adapterCannotBorrowOnBehalfOfTheZapWithoutDelegation() public {
        if (!_skipUnlessForked()) return;

        address zapAddress = _deploySupplyZap("aave-borrow-nodelegation");
        _fundWeth(zapAddress, 1 ether);
        vm.startPrank(zapAddress);
        IERC20Live(WETH).approve(POOL, 1 ether);
        IPoolLive(POOL).supply(WETH, 1 ether, zapAddress, 0);
        vm.stopPrank();

        (,, uint256 borrowable,,,) = IPoolLive(POOL).getUserAccountData(zapAddress);
        assertGt(borrowable, 0, "the zap does have borrowing power");

        address hypotheticalAdapter = makeAddr("hypothetical-borrow-adapter");
        assertEq(IVariableDebtTokenLive(vdUSDC).borrowAllowance(zapAddress, hypotheticalAdapter), 0);

        vm.prank(hypotheticalAdapter);
        (bool ok, bytes memory err) = POOL.call(
            abi.encodeWithSelector(IPoolLive.borrow.selector, USDC, uint256(100e6), uint256(2), uint16(0), zapAddress)
        );
        assertFalse(ok, "Aave must reject an undelegated borrow on behalf of the zap");
        emit log_named_bytes("undelegated borrow revert", err);
        // Aave v3.4 on Base: InsufficientBorrowAllowance(delegatee, allowance, amount).
        assertEq(
            err,
            abi.encodeWithSelector(
                bytes4(keccak256("InsufficientBorrowAllowance(address,uint256,uint256)")),
                hypotheticalAdapter,
                uint256(0),
                uint256(100e6)
            ),
            "expected InsufficientBorrowAllowance"
        );
        assertEq(IERC20Live(USDC).balanceOf(hypotheticalAdapter), 0);
        assertEq(IVariableDebtTokenLive(vdUSDC).balanceOf(zapAddress), 0, "no debt was opened");
    }

    /// @notice The missing piece is exactly one call — `approveDelegation` — and only the zap can make
    ///         it. Delegation granted BY the zap makes the identical adapter borrow succeed, which is
    ///         what makes this a call-surface problem and not an Aave problem.
    function test_borrow_succeedsOnlyAfterTheZapItselfGrantsDelegation() public {
        if (!_skipUnlessForked()) return;

        address zapAddress = _deploySupplyZap("aave-borrow-delegation");
        _fundWeth(zapAddress, 1 ether);
        vm.startPrank(zapAddress);
        IERC20Live(WETH).approve(POOL, 1 ether);
        IPoolLive(POOL).supply(WETH, 1 ether, zapAddress, 0);
        // Only the debtor can grant this, and OpenZap can never emit this selector.
        IVariableDebtTokenLive(vdUSDC).approveDelegation(makeAddr("delegatee"), 100e6);
        vm.stopPrank();

        address delegatee = makeAddr("delegatee");
        assertEq(IVariableDebtTokenLive(vdUSDC).borrowAllowance(zapAddress, delegatee), 100e6);

        vm.prank(delegatee);
        IPoolLive(POOL).borrow(USDC, 100e6, 2, 0, zapAddress);

        // The borrowed asset is credited to the DELEGATEE, while the debt sits on the zap. Even in the
        // impossible world where the zap could delegate, the adapter would have to hand the proceeds
        // back, and the zap would carry a debt no step can ever repay or measure.
        assertEq(IERC20Live(USDC).balanceOf(delegatee), 100e6, "proceeds go to the delegatee, not the debtor");
        assertGt(IVariableDebtTokenLive(vdUSDC).balanceOf(zapAddress), 0, "debt sits on the zap");
        assertEq(IERC20Live(USDC).balanceOf(zapAddress), 0);
    }

    /// @notice The only approval primitive OpenZap can emit is `approve(address,uint256)` on a step's
    ///         `tokenIn`. Pointing a step at the variable-debt token — the one address where a
    ///         delegation could conceivably be smuggled through — dies inside the Aave debt token,
    ///         which reverts `OperationNotSupported()` for every ERC-20 approval entry point.
    function test_borrow_openZapApprovalPrimitiveCannotReachCreditDelegation() public {
        if (!_skipUnlessForked()) return;

        // Selectors are different functions; there is no overlap to exploit.
        assertTrue(
            IERC20Live.approve.selector != IVariableDebtTokenLive.approveDelegation.selector,
            "approve and approveDelegation are distinct selectors"
        );

        // Direct proof that the debt token refuses the ERC-20 approval surface.
        (bool ok, bytes memory err) =
            vdUSDC.call(abi.encodeWithSelector(IERC20Live.approve.selector, address(supplyAdapter), uint256(1)));
        assertFalse(ok, "Aave debt token must refuse approve()");
        assertEq(bytes4(err), bytes4(keccak256("OperationNotSupported()")), "expected OperationNotSupported()");

        // And the same proof through a real zap: a step whose tokenIn is the debt token cannot execute.
        allowlist.setToken(vdUSDC, true);
        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(supplyAdapter), tokenIn: vdUSDC, spender: address(supplyAdapter), amountIn: 1, data: ""
        });
        address[] memory tracked = new address[](1);
        tracked[0] = WETH;
        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
        address zapAddress = factory.createZap(policy, keccak256("aave-delegation-smuggle"));
        OpenZap zap = OpenZap(payable(zapAddress));

        OpenZapIntent memory intent = _intent(zap, owner, WETH, 0);
        bytes memory sig = _sign(zap, intent, OWNER_PK);
        vm.expectRevert(SafeApprove.ApproveFailed.selector);
        zap.execute(intent, sig);
    }

    /// @notice The third, independent reason not to ship a borrow adapter: an open debt position on a
    ///         zap bricks `emergencyExit`. Collateral aTokens cannot leave a borrower whose health
    ///         factor would fall below 1, so OpenZap's ONE unconditional recovery path reverts and the
    ///         owner's funds are stuck behind a debt no step can repay.
    function test_borrow_wouldBrickEmergencyExitOnTheZap() public {
        if (!_skipUnlessForked()) return;

        address zapAddress = _deploySupplyZap("aave-borrow-bricks-exit");
        _fundWeth(zapAddress, 1 ether);

        vm.startPrank(zapAddress);
        IERC20Live(WETH).approve(POOL, 1 ether);
        IPoolLive(POOL).supply(WETH, 1 ether, zapAddress, 0);
        IPoolLive(POOL).borrow(USDC, 500e6, 2, 0, zapAddress);
        vm.stopPrank();

        assertGt(IERC20Live(aWETH).balanceOf(zapAddress), 0);
        assertGt(IVariableDebtTokenLive(vdUSDC).balanceOf(zapAddress), 0);

        address[] memory assets = new address[](1);
        assets[0] = aWETH;
        vm.prank(owner);
        vm.expectRevert(SafeApprove.TransferFailed.selector);
        OpenZap(payable(zapAddress)).emergencyExit(assets);

        // With no debt the very same exit succeeds — the debt is the thing that brakes recovery.
        address cleanZap = _deploySupplyZap("aave-borrow-bricks-exit-control");
        _fundWeth(cleanZap, 1 ether);
        vm.startPrank(cleanZap);
        IERC20Live(WETH).approve(POOL, 1 ether);
        IPoolLive(POOL).supply(WETH, 1 ether, cleanZap, 0);
        vm.stopPrank();
        vm.prank(owner);
        OpenZap(payable(cleanZap)).emergencyExit(assets);
        assertGt(IERC20Live(aWETH).balanceOf(owner), 0, "debt-free collateral is recoverable");
    }

    /// @notice The rejected workaround, priced out. If an adapter supplied `onBehalfOf: address(this)`
    ///         so it could borrow as itself, the Aave account — and therefore the collateral — belongs
    ///         to the shared adapter. The zap's owner-only `emergencyExit` then recovers nothing, which
    ///         breaks the one unconditional recovery path OpenZap has.
    function test_borrow_adapterHeldCollateralWouldEscapeEmergencyExit() public {
        if (!_skipUnlessForked()) return;

        address zapAddress = _deploySupplyZap("aave-adapter-held-collateral");
        address sharedAdapter = makeAddr("adapter-as-borrower");
        _fundWeth(sharedAdapter, 1 ether);

        vm.startPrank(sharedAdapter);
        IERC20Live(WETH).approve(POOL, 1 ether);
        IPoolLive(POOL).supply(WETH, 1 ether, sharedAdapter, 0);
        vm.stopPrank();

        (uint256 adapterColl,,,,,) = IPoolLive(POOL).getUserAccountData(sharedAdapter);
        assertGt(adapterColl, 0, "collateral is booked to the adapter, not the zap");
        (uint256 zapColl,,,,,) = IPoolLive(POOL).getUserAccountData(zapAddress);
        assertEq(zapColl, 0);

        // The user's only unconditional recovery path returns nothing: the position is not theirs.
        address[] memory assets = new address[](2);
        assets[0] = aWETH;
        assets[1] = WETH;
        vm.prank(owner);
        OpenZap(payable(zapAddress)).emergencyExit(assets);
        assertEq(IERC20Live(aWETH).balanceOf(owner), 0, "emergencyExit cannot reach adapter-held collateral");
        assertGt(IERC20Live(aWETH).balanceOf(sharedAdapter), 0, "the collateral is stranded on the adapter");
    }

    // ------------------------------------------------------------------ //
    // Helpers                                                            //
    // ------------------------------------------------------------------ //

    function _deploySupplyZap(string memory salt) internal returns (address) {
        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(supplyAdapter), tokenIn: WETH, spender: address(supplyAdapter), amountIn: 1 ether, data: ""
        });
        address[] memory tracked = new address[](2);
        tracked[0] = WETH;
        tracked[1] = aWETH;
        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
        return factory.createZap(policy, keccak256(bytes(salt)));
    }

    function _intent(OpenZap zap, address recipient, address outAsset, uint256 minOut)
        internal
        view
        returns (OpenZapIntent memory)
    {
        return OpenZapIntent({
            zap: address(zap),
            chainId: block.chainid,
            nonce: 0,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 10 minutes),
            recipient: recipient,
            relayer: address(0),
            maxRelayerFee: 0,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: outAsset,
            minOut: minOut
        });
    }

    function _sign(OpenZap zap, OpenZapIntent memory intent, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, zap.hashIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    receive() external payable {}
}
