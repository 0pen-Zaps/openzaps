// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {AaveV3SupplyAdapter} from "../src/adapters/AaveV3SupplyAdapter.sol";
import {AaveV3WithdrawAdapter} from "../src/adapters/AaveV3WithdrawAdapter.sol";
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

interface IATokenLive is IERC20Live {
    function scaledBalanceOf(address user) external view returns (uint256);
}

interface IPoolLive {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getReserveAToken(address asset) external view returns (address);
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

// --------------------------------------------------------------------------------------------- //
// Mocks for the negative/guard paths (never touch the live Pool)                                //
// --------------------------------------------------------------------------------------------- //

/// @dev A transferable aToken stand-in that also answers `UNDERLYING_ASSET_ADDRESS`.
contract MockAToken is MockERC20 {
    address public immutable underlying;

    constructor(address underlying_) MockERC20("Mock aToken", "aMCK", 18) {
        underlying = underlying_;
    }

    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return underlying;
    }
}

/// @dev A Pool whose `withdraw` re-enters the adapter, to prove the reentrancy guard fires AFTER the
///      aToken has already been pulled into the adapter.
contract ReentrantWithdrawPool {
    address public immutable aToken;
    address public adapter;

    constructor(address aToken_) {
        aToken = aToken_;
    }

    function setAdapter(address adapter_) external {
        adapter = adapter_;
    }

    function getReserveAToken(address) external view returns (address) {
        return aToken;
    }

    function withdraw(address, uint256, address) external returns (uint256) {
        // Re-enter: the guard is already set, so this reverts before doing anything.
        AaveV3WithdrawAdapter(adapter).execute(aToken, 1, "");
        return 0;
    }
}

/// @dev A Pool that reports one aToken at construction and a different one afterwards, to drive the
///      `ATokenReplaced` guard.
contract ReplacingPool {
    address public aToken;

    constructor(address aToken_) {
        aToken = aToken_;
    }

    function flip(address aToken_) external {
        aToken = aToken_;
    }

    function getReserveAToken(address) external view returns (address) {
        return aToken;
    }

    function withdraw(address, uint256, address) external pure returns (uint256) {
        return 0;
    }
}

/// @title AaveV3WithdrawAdapterForkTest
/// @notice Base-mainnet fork proof for `AaveV3WithdrawAdapter`: the unwind leg for `AaveV3SupplyAdapter`.
/// @dev Creates its OWN pinned fork (never inherits an ambient `--fork-url`) for the same three reasons
///      the supply suite documents: no silent skip, determinism, and a warm RPC disk cache.
///          forge test --match-contract AaveV3WithdrawAdapterForkTest \
///            --fork-url https://mainnet.base.org -vv
contract AaveV3WithdrawAdapterForkTest is Test {
    uint256 internal constant BASE_CHAIN_ID = 8453;
    uint256 internal constant FORK_BLOCK = 48_900_000;

    address internal constant POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    bool internal forked;
    address internal aWETH;

    AdapterRegistry internal registry;
    TokenAllowlist internal allowlist;
    OpenZapFactory internal factory;
    AaveV3SupplyAdapter internal supplyAdapter;
    AaveV3WithdrawAdapter internal withdrawAdapter;

    // A signer whose address is a plain EOA on Base. Some low private keys derive to addresses that
    // carry EIP-7702 delegation code on Base mainnet, which would send OpenZap's signature check down
    // the ERC-1271 path and fail as a confusing `BadSignature`; setUp asserts this one stays code-free.
    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")), FORK_BLOCK);
        forked = true;

        assertGt(POOL.code.length, 0, "no Aave v3 Pool at the pinned address");
        aWETH = IPoolLive(POOL).getReserveAToken(WETH);
        assertGt(aWETH.code.length, 0, "no aWETH");

        registry = new AdapterRegistry(address(this));
        allowlist = new TokenAllowlist(address(this));
        factory = new OpenZapFactory(registry, allowlist);
        supplyAdapter = new AaveV3SupplyAdapter(POOL, WETH);
        withdrawAdapter = new AaveV3WithdrawAdapter(POOL, WETH);

        registry.setAdapter(address(supplyAdapter), true);
        registry.setAdapter(address(withdrawAdapter), true);
        allowlist.setToken(WETH, true);
        allowlist.setToken(aWETH, true);

        owner = vm.addr(OWNER_PK);
        assertEq(owner.code.length, 0, "owner must be a plain EOA (no ERC-1271/7702 code) for ECDSA signing");
    }

    function _skipUnlessForked() internal returns (bool ok) {
        if (!forked) {
            vm.skip(true);
            return false;
        }
        return true;
    }

    // ------------------------------------------------------------------ //
    // Seeding helpers                                                    //
    // ------------------------------------------------------------------ //

    function _fundWeth(address to, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        IWETHLive(WETH).deposit{value: amount}();
        IERC20Live(WETH).transfer(to, amount);
    }

    /// @dev Real Aave supply performed AS `who` (the account holder), the way the supply adapter leaves
    ///      a zap. Returns the aWETH balance the account actually received.
    function _supplyAs(address who, uint256 wethAmount) internal returns (uint256 aWethReceived) {
        _fundWeth(who, wethAmount);
        vm.startPrank(who);
        IERC20Live(WETH).approve(POOL, wethAmount);
        IPoolLive(POOL).supply(WETH, wethAmount, who, 0);
        vm.stopPrank();
        aWethReceived = IERC20Live(aWETH).balanceOf(who);
    }

    // ------------------------------------------------------------------ //
    // Construction wiring                                                //
    // ------------------------------------------------------------------ //

    function test_constructorResolvesTheReserveAToken() public view {
        assertEq(withdrawAdapter.pool(), POOL);
        assertEq(withdrawAdapter.asset(), WETH);
        assertEq(withdrawAdapter.aToken(), aWETH, "aToken must resolve to the live reserve aToken");
    }

    function test_constructorRefusesAnUnlistedReserve() public {
        // A random ERC-20 with code but no Aave reserve resolves to a zero aToken.
        MockERC20 notAReserve = new MockERC20("X", "X", 18);
        vm.expectRevert(abi.encodeWithSelector(AaveV3WithdrawAdapter.ReserveNotListed.selector, address(notAReserve)));
        new AaveV3WithdrawAdapter(POOL, address(notAReserve));
    }

    function test_constructorRefusesCodelessAndZeroInputs() public {
        vm.expectRevert(AaveV3WithdrawAdapter.ZeroAddress.selector);
        new AaveV3WithdrawAdapter(address(0), WETH);

        // Guarantee a codeless pool address: many Base addresses carry EIP-7702 delegation code, which
        // would slip past `_requireCode` and revert later inside `getReserveAToken` instead.
        address eoa = makeAddr("eoa-nocode");
        vm.etch(eoa, hex"");
        assertEq(eoa.code.length, 0, "probe address must be codeless");
        vm.expectRevert(abi.encodeWithSelector(AaveV3WithdrawAdapter.NoCode.selector, eoa));
        new AaveV3WithdrawAdapter(eoa, WETH);
    }

    function test_constructorRefusesWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(AaveV3WithdrawAdapter.WrongChain.selector, uint256(1)));
        new AaveV3WithdrawAdapter(POOL, WETH);
        vm.chainId(BASE_CHAIN_ID);
    }

    // ------------------------------------------------------------------ //
    // The clean direct-call case                                         //
    // ------------------------------------------------------------------ //

    /// @notice aToken in from the caller, underlying out to the caller, adapter keeps nothing, and it
    ///         needs — and leaves — NO allowance to the Pool.
    function test_withdraw_underlyingLandsOnCallerAndAdapterKeepsNothing() public {
        if (!_skipUnlessForked()) return;

        address zap = makeAddr("aave-withdraw-caller");
        uint256 seeded = _supplyAs(zap, 1 ether);
        uint256 amountIn = seeded; // unwind the whole position

        uint256 callerWethBefore = IERC20Live(WETH).balanceOf(zap);

        // The adapter never approves the Pool; prove it is zero before and stays zero.
        assertEq(IERC20Live(aWETH).allowance(address(withdrawAdapter), POOL), 0, "pre pool allowance");

        vm.startPrank(zap);
        IERC20Live(aWETH).approve(address(withdrawAdapter), amountIn);
        (address tokenOut, uint256 amountOut) = withdrawAdapter.execute(aWETH, amountIn, "");
        vm.stopPrank();

        assertEq(tokenOut, WETH, "tokenOut must be the reserve underlying");
        assertApproxEqAbs(amountOut, amountIn, 1, "measured underlying delta ~= aToken burned");
        assertEq(IERC20Live(WETH).balanceOf(zap) - callerWethBefore, amountOut, "adapter must report what it measured");

        // The caller's aToken is gone (unwound in full).
        assertApproxEqAbs(IERC20Live(aWETH).balanceOf(zap), 0, 1, "aToken not unwound");

        // The adapter is a pass-through: no aToken, no underlying, no allowance anywhere.
        assertEq(IERC20Live(aWETH).balanceOf(address(withdrawAdapter)), 0, "adapter holds aToken");
        assertEq(IERC20Live(WETH).balanceOf(address(withdrawAdapter)), 0, "adapter holds underlying");
        assertEq(IERC20Live(aWETH).allowance(address(withdrawAdapter), POOL), 0, "residual pool allowance");
        assertEq(IERC20Live(WETH).allowance(zap, address(withdrawAdapter)), 0, "caller allowance not consumed");
    }

    /// @notice The withdraw is booked to the CALLER's Aave account: collateral falls, and with no debt
    ///         the health factor is uint256.max throughout. This reads the health factor as required.
    function test_withdraw_debitsCallerAccountAndHealthFactor() public {
        if (!_skipUnlessForked()) return;

        address zap = makeAddr("aave-withdraw-account");
        uint256 seeded = _supplyAs(zap, 2 ether);

        (uint256 collBefore, uint256 debtBefore,,,, uint256 hfBefore) = IPoolLive(POOL).getUserAccountData(zap);
        assertGt(collBefore, 0, "seed must credit collateral");
        assertEq(debtBefore, 0);
        assertEq(hfBefore, type(uint256).max, "no debt => infinite health factor");

        uint256 amountIn = 1 ether; // partial unwind
        vm.startPrank(zap);
        IERC20Live(aWETH).approve(address(withdrawAdapter), amountIn);
        withdrawAdapter.execute(aWETH, amountIn, "");
        vm.stopPrank();

        (uint256 collAfter, uint256 debtAfter,,,, uint256 hfAfter) = IPoolLive(POOL).getUserAccountData(zap);
        assertLt(collAfter, collBefore, "withdraw must debit the caller's collateral");
        assertGt(collAfter, 0, "partial unwind leaves collateral behind");
        assertEq(debtAfter, 0);
        assertEq(hfAfter, type(uint256).max);
        assertApproxEqAbs(IERC20Live(aWETH).balanceOf(zap), seeded - amountIn, 2, "exactly amountIn unwound");

        // Nothing was ever credited to the adapter's own Aave account.
        (uint256 adapterColl,,,,,) = IPoolLive(POOL).getUserAccountData(address(withdrawAdapter));
        assertEq(adapterColl, 0, "adapter must never become the Aave account holder");
    }

    /// @notice The pulled aToken is burned exactly: the adapter holds zero aToken (and zero scaled
    ///         balance) after the call, so no dust can accumulate on the shared adapter.
    function test_withdraw_burnsExactlyAndLeavesNoDust() public {
        if (!_skipUnlessForked()) return;

        address zap = makeAddr("aave-withdraw-nodust");
        uint256 seeded = _supplyAs(zap, 3 ether);
        uint256 amountIn = 1_234567890123456789; // an awkward, non-round amount

        uint256 callerAtokenBefore = IERC20Live(aWETH).balanceOf(zap);
        vm.startPrank(zap);
        IERC20Live(aWETH).approve(address(withdrawAdapter), amountIn);
        withdrawAdapter.execute(aWETH, amountIn, "");
        vm.stopPrank();

        // The caller lost exactly the face amount pulled (interest on the remainder is negligible in
        // the same block, but allow 1 wei for the index tick the withdraw itself performs).
        assertApproxEqAbs(callerAtokenBefore - IERC20Live(aWETH).balanceOf(zap), amountIn, 2, "not an exact burn");
        assertApproxEqAbs(IERC20Live(aWETH).balanceOf(zap), seeded - amountIn, 2, "remainder wrong");

        // The shared adapter carries no aToken dust of any kind.
        assertEq(IERC20Live(aWETH).balanceOf(address(withdrawAdapter)), 0, "aToken balance dust");
        assertEq(IATokenLive(aWETH).scaledBalanceOf(address(withdrawAdapter)), 0, "aToken scaled dust");
        assertEq(IERC20Live(WETH).balanceOf(address(withdrawAdapter)), 0, "underlying dust");
    }

    /// @notice The adapter FLUSHES: it always ends with a zero aToken balance, even when a stray aToken
    ///         was parked on it beforehand. That stray balance is withdrawn along with the caller's own
    ///         and paid to the caller — the documented finders-keepers property of a pass-through — and
    ///         crucially the adapter never retains dust. (A zap's own aTokens are never at risk: they
    ///         live on the zap and are only ever pulled up to the exact allowance a signed intent
    ///         grants; see `test_withdraw_burnsExactlyAndLeavesNoDust`.)
    function test_withdraw_flushesToZeroResidual() public {
        if (!_skipUnlessForked()) return;

        // Park a real aWETH donation on the shared adapter.
        address donor = makeAddr("donor");
        uint256 donation = _supplyAs(donor, 1 ether);
        vm.prank(donor);
        IERC20Live(aWETH).transfer(address(withdrawAdapter), donation);
        assertEq(IERC20Live(aWETH).balanceOf(address(withdrawAdapter)), donation, "donation not parked");

        address zap = makeAddr("aave-withdraw-flush");
        _supplyAs(zap, 1 ether);
        uint256 amountIn = 0.5 ether;
        uint256 callerWethBefore = IERC20Live(WETH).balanceOf(zap);

        vm.startPrank(zap);
        IERC20Live(aWETH).approve(address(withdrawAdapter), amountIn);
        (, uint256 amountOut) = withdrawAdapter.execute(aWETH, amountIn, "");
        vm.stopPrank();

        // The caller's payout is what the adapter measured, and it equals its own pull plus the swept
        // donation (flush semantics), never less.
        assertEq(IERC20Live(WETH).balanceOf(zap) - callerWethBefore, amountOut, "measured payout mismatch");
        assertApproxEqAbs(amountOut, amountIn + donation, 2, "flush must pay pull + stray balance");
        // The whole point: the shared adapter is left holding exactly nothing.
        assertEq(IERC20Live(aWETH).balanceOf(address(withdrawAdapter)), 0, "aToken residual after flush");
        assertEq(IATokenLive(aWETH).scaledBalanceOf(address(withdrawAdapter)), 0, "scaled residual after flush");
        assertEq(IERC20Live(WETH).balanceOf(address(withdrawAdapter)), 0, "underlying residual after flush");
    }

    /// @notice A withdraw succeeds while the adapter holds a ZERO aToken allowance to the Pool the
    ///         entire time — the Pool burns the adapter's aToken directly, it does not pull it.
    function test_withdraw_needsNoATokenAllowanceToThePool() public {
        if (!_skipUnlessForked()) return;

        address zap = makeAddr("aave-withdraw-noapproval");
        uint256 amountIn = _supplyAs(zap, 1 ether);

        assertEq(IERC20Live(aWETH).allowance(address(withdrawAdapter), POOL), 0, "pre");
        vm.startPrank(zap);
        IERC20Live(aWETH).approve(address(withdrawAdapter), amountIn);
        (, uint256 amountOut) = withdrawAdapter.execute(aWETH, amountIn, "");
        vm.stopPrank();
        assertGt(amountOut, 0, "withdraw produced no output");
        assertEq(IERC20Live(aWETH).allowance(address(withdrawAdapter), POOL), 0, "post");
    }

    // ------------------------------------------------------------------ //
    // Through real OpenZap clones                                        //
    // ------------------------------------------------------------------ //

    /// @notice The headline round trip: a supply zap turns WETH into aWETH and settles it onto a
    ///         withdraw zap, which then turns the aWETH back into WETH for the owner — both legs frozen
    ///         policies executed under owner-signed intents through real clones.
    function test_supplyThenWithdraw_roundTripThroughRealClones() public {
        if (!_skipUnlessForked()) return;

        uint256 supplyAmount = 1 ether;
        uint256 withdrawAmount = 0.5 ether; // a robust round number <= what the supply produces

        // Build the WITHDRAW zap first so we know its address; the supply zap will settle onto it.
        address withdrawZapAddr = _deployWithdrawZap("rt-withdraw", withdrawAmount, owner);

        // Supply zap: WETH -> aWETH, recipient = the withdraw zap.
        address supplyZapAddr = _deploySupplyZap("rt-supply", supplyAmount, withdrawZapAddr);
        OpenZap supplyZap = OpenZap(payable(supplyZapAddr));
        _fundWeth(supplyZapAddr, supplyAmount);

        // Execute the supply leg: aWETH lands on the withdraw zap.
        OpenZapIntent memory sIntent = _intent(supplyZap, withdrawZapAddr, aWETH, supplyAmount - 1);
        supplyZap.execute(sIntent, _sign(supplyZap, sIntent, OWNER_PK));
        uint256 aWethOnWithdrawZap = IERC20Live(aWETH).balanceOf(withdrawZapAddr);
        assertApproxEqAbs(aWethOnWithdrawZap, supplyAmount, 2, "withdraw zap did not receive the aToken");
        assertGe(aWethOnWithdrawZap, withdrawAmount, "not enough aToken to unwind");

        // Execute the withdraw leg: WETH back to the owner.
        OpenZap withdrawZap = OpenZap(payable(withdrawZapAddr));
        uint256 ownerWethBefore = IERC20Live(WETH).balanceOf(owner);

        // A min-out above what the withdraw can produce must fail, and must not burn the nonce.
        // (Sign BEFORE `expectRevert`: `_sign` calls `hashIntent`, an external staticcall, and inlining
        // it as an argument would make `expectRevert` bind to that call instead of `execute`.)
        OpenZapIntent memory greedy = _intent(withdrawZap, owner, WETH, withdrawAmount + 1 ether);
        bytes memory greedySig = _sign(withdrawZap, greedy, OWNER_PK);
        vm.expectRevert(OpenZap.MinOutNotMet.selector);
        withdrawZap.execute(greedy, greedySig);
        assertFalse(withdrawZap.nonceUsed(0));

        OpenZapIntent memory wIntent = _intent(withdrawZap, owner, WETH, withdrawAmount - 1);
        bytes memory wSig = _sign(withdrawZap, wIntent, OWNER_PK);
        withdrawZap.execute(wIntent, wSig);

        assertTrue(withdrawZap.nonceUsed(0));
        assertApproxEqAbs(
            IERC20Live(WETH).balanceOf(owner) - ownerWethBefore, withdrawAmount, 1, "owner did not receive the WETH"
        );
        // The withdraw zap burned exactly `withdrawAmount` of aToken.
        assertApproxEqAbs(IERC20Live(aWETH).balanceOf(withdrawZapAddr), aWethOnWithdrawZap - withdrawAmount, 2);
        // No dust anywhere on the adapter path.
        assertEq(IERC20Live(WETH).balanceOf(withdrawZapAddr), 0, "underlying dust on the zap");
        assertEq(IERC20Live(aWETH).balanceOf(address(withdrawAdapter)), 0);
        assertEq(IERC20Live(WETH).balanceOf(address(withdrawAdapter)), 0);
        assertEq(IERC20Live(aWETH).allowance(withdrawZapAddr, address(withdrawAdapter)), 0, "residual step allowance");
    }

    /// @notice A standalone withdraw zap, seeded by a real supply, settles the measured underlying
    ///         delta to the recipient — and a too-greedy intent fails without burning the nonce.
    function test_withdraw_settlesThroughOpenZap() public {
        if (!_skipUnlessForked()) return;

        uint256 withdrawAmount = 1 ether;
        address withdrawZapAddr = _deployWithdrawZap("standalone-withdraw", withdrawAmount, owner);

        // Seed the zap with real aWETH by supplying AS the zap (this is the supply leg).
        _supplyAs(withdrawZapAddr, 2 ether);

        (uint256 collBefore,,,,, uint256 hfBefore) = IPoolLive(POOL).getUserAccountData(withdrawZapAddr);
        assertGt(collBefore, 0);
        assertEq(hfBefore, type(uint256).max);

        OpenZap zap = OpenZap(payable(withdrawZapAddr));
        uint256 recipientBefore = IERC20Live(WETH).balanceOf(owner);

        OpenZapIntent memory intent = _intent(zap, owner, WETH, withdrawAmount - 1);
        zap.execute(intent, _sign(zap, intent, OWNER_PK));

        assertTrue(zap.nonceUsed(0));
        assertApproxEqAbs(IERC20Live(WETH).balanceOf(owner) - recipientBefore, withdrawAmount, 1, "recipient underpaid");

        (uint256 collAfter,,,,, uint256 hfAfter) = IPoolLive(POOL).getUserAccountData(withdrawZapAddr);
        assertLt(collAfter, collBefore, "collateral must fall after a withdraw");
        assertEq(hfAfter, type(uint256).max, "still no debt");

        assertEq(IERC20Live(WETH).balanceOf(withdrawZapAddr), 0, "underlying dust in the zap");
        assertEq(IERC20Live(aWETH).balanceOf(address(withdrawAdapter)), 0);
        assertEq(IERC20Live(WETH).allowance(withdrawZapAddr, address(withdrawAdapter)), 0, "residual step allowance");
    }

    // ------------------------------------------------------------------ //
    // Refusals & guards                                                  //
    // ------------------------------------------------------------------ //

    function test_withdraw_refusals() public {
        if (!_skipUnlessForked()) return;

        address zap = makeAddr("aave-withdraw-refusals");
        uint256 seeded = _supplyAs(zap, 1 ether);

        vm.startPrank(zap);
        IERC20Live(aWETH).approve(address(withdrawAdapter), seeded);

        // Wrong tokenIn: only the reserve aToken is accepted.
        vm.expectRevert(abi.encodeWithSelector(AaveV3WithdrawAdapter.UnsupportedToken.selector, WETH));
        withdrawAdapter.execute(WETH, seeded, "");

        // Any data at all is refused.
        vm.expectRevert(AaveV3WithdrawAdapter.UnexpectedData.selector);
        withdrawAdapter.execute(aWETH, seeded, hex"00");

        // Zero amount.
        vm.expectRevert(AaveV3WithdrawAdapter.ZeroAmount.selector);
        withdrawAdapter.execute(aWETH, 0, "");
        vm.stopPrank();

        // Wrong chain, checked again on every call.
        vm.chainId(1);
        vm.prank(zap);
        vm.expectRevert(abi.encodeWithSelector(AaveV3WithdrawAdapter.WrongChain.selector, uint256(1)));
        withdrawAdapter.execute(aWETH, seeded, "");
        vm.chainId(BASE_CHAIN_ID);

        // Nothing moved on any refusal path.
        assertEq(IERC20Live(aWETH).balanceOf(zap), seeded);
        assertEq(IERC20Live(aWETH).balanceOf(address(withdrawAdapter)), 0);
    }

    /// @notice If Aave repoints the reserve's aToken between construction and a call, the adapter stops
    ///         rather than pull or measure a stale token. Driven with a mock Pool.
    function test_withdraw_aTokenReplacedGuardHalts() public {
        MockERC20 underlying = new MockERC20("U", "U", 18);
        MockAToken a1 = new MockAToken(address(underlying));
        ReplacingPool p = new ReplacingPool(address(a1));

        AaveV3WithdrawAdapter adapter = new AaveV3WithdrawAdapter(address(p), address(underlying));
        assertEq(adapter.aToken(), address(a1));

        // Governance swaps the aToken address out from under the adapter.
        MockAToken a2 = new MockAToken(address(underlying));
        p.flip(address(a2));

        address caller = makeAddr("replaced-caller");
        a1.mint(caller, 1 ether);
        vm.startPrank(caller);
        a1.approve(address(adapter), 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(AaveV3WithdrawAdapter.ATokenReplaced.selector, address(a1), address(a2))
        );
        adapter.execute(address(a1), 1 ether, "");
        vm.stopPrank();

        // The guard fires BEFORE any pull: the caller keeps its aToken.
        assertEq(a1.balanceOf(caller), 1 ether);
    }

    /// @notice A Pool that re-enters the adapter from inside `withdraw` — after the aToken has already
    ///         been pulled in — is stopped by the guard, and the whole call reverts.
    function test_withdraw_reentrancyGuardBlocksAMaliciousPool() public {
        MockERC20 underlying = new MockERC20("U", "U", 18);
        MockAToken aTok = new MockAToken(address(underlying));
        ReentrantWithdrawPool evilPool = new ReentrantWithdrawPool(address(aTok));
        AaveV3WithdrawAdapter evilAdapter = new AaveV3WithdrawAdapter(address(evilPool), address(underlying));
        evilPool.setAdapter(address(evilAdapter));

        address caller = makeAddr("reentrancy-caller");
        aTok.mint(caller, 10 ether);
        vm.startPrank(caller);
        aTok.approve(address(evilAdapter), 10 ether);
        vm.expectRevert(AaveV3WithdrawAdapter.Reentrancy.selector);
        evilAdapter.execute(address(aTok), 1 ether, "");
        vm.stopPrank();

        // The reverted call unwinds the pull too: the caller keeps everything.
        assertEq(aTok.balanceOf(caller), 10 ether);
        assertEq(aTok.balanceOf(address(evilAdapter)), 0);
    }

    // ------------------------------------------------------------------ //
    // Policy builders / intent helpers                                   //
    // ------------------------------------------------------------------ //

    function _deploySupplyZap(string memory salt, uint256 amountIn, address recipient) internal returns (address) {
        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(supplyAdapter), tokenIn: WETH, spender: address(supplyAdapter), amountIn: amountIn, data: ""
        });
        address[] memory tracked = new address[](2);
        tracked[0] = WETH;
        tracked[1] = aWETH;
        Policy memory policy = Policy({
            owner: owner,
            recipient: recipient,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
        return factory.createZap(policy, keccak256(bytes(salt)));
    }

    function _deployWithdrawZap(string memory salt, uint256 amountIn, address recipient) internal returns (address) {
        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(withdrawAdapter),
            tokenIn: aWETH,
            spender: address(withdrawAdapter),
            amountIn: amountIn,
            data: ""
        });
        address[] memory tracked = new address[](2);
        tracked[0] = aWETH;
        tracked[1] = WETH;
        Policy memory policy = Policy({
            owner: owner,
            recipient: recipient,
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
