// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {PoolKey, RobinhoodV4NativePoolAdapter, SwapParams} from "../src/adapters/RobinhoodV4NativePoolAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeeOnTransferERC20} from "./mocks/MockFeeOnTransferERC20.sol";

/// @notice Wrapped-native mock with the two capabilities the adapter uses: `withdraw` sends native
///         to the caller, `deposit` mints against received native. Par by construction.
contract MockWrappedNative is MockERC20 {
    constructor() MockERC20("Wrapped Ether", "aeWETH", 18) {}

    function deposit() external payable {
        totalSupply += msg.value;
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "native send");
    }

    receive() external payable {}
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

interface IAdapterExecute {
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        returns (address tokenOut, uint256 amountOut);
}

/// @notice A v4-core PoolManager stand-in strict enough to prove the adapter's sequences: the
///         unlock/callback shape, exact-input consumption, take/settle bookkeeping for BOTH the
///         native and ERC-20 legs, and slot0 reads. Misbehavior modes let each refusal be tested.
contract MockV4NativePoolManager {
    MockERC20 public token; // currency1
    uint160 public sqrtPrice = uint160(1) << 96;
    /// @dev Output per unit input, in wad (1e18 = 1:1). Buys multiply, sells divide.
    uint256 public buyRateWad = 2e18;
    uint256 public sellRateWad = 5e17;
    /// @dev Fraction of the requested input actually consumed, in bps. Below 10000 simulates a
    ///      pool whose liquidity runs out before the exact input — a partial fill.
    uint256 public consumeBps = 10_000;
    /// @dev Misbehavior switches.
    bool public skipCallback;
    bool public tamperCallback;
    bool public reenterDuringUnlock;
    uint256 public driftNativeWei;

    uint256 private _owedNative;
    uint256 private _owedToken;
    uint256 private _synced;
    bool private _syncedSet;

    function setToken(MockERC20 token_) external {
        token = token_;
    }

    function setSqrtPrice(uint160 value) external {
        sqrtPrice = value;
    }

    function setRates(uint256 buyRateWad_, uint256 sellRateWad_) external {
        buyRateWad = buyRateWad_;
        sellRateWad = sellRateWad_;
    }

    function setConsumeBps(uint256 value) external {
        consumeBps = value;
    }

    function setSkipCallback(bool value) external {
        skipCallback = value;
    }

    function setTamperCallback(bool value) external {
        tamperCallback = value;
    }

    function setReenterDuringUnlock(bool value) external {
        reenterDuringUnlock = value;
    }

    function setDriftNativeWei(uint256 value) external {
        driftNativeWei = value;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        if (reenterDuringUnlock) {
            // A hostile manager tries to re-enter the adapter mid-flight; the mutex must hold.
            IAdapterExecute(msg.sender).execute(address(token), 1, "");
        }
        if (skipCallback) return "";
        if (tamperCallback) return IUnlockCallback(msg.sender).unlockCallback(abi.encode(true, uint256(1)));
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata) external returns (int256) {
        require(key.currency0 == address(0) && key.currency1 == address(token), "pool key");
        require(params.amountSpecified < 0, "exact input only");
        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 consumed = (amountIn * consumeBps) / 10_000;
        if (driftNativeWei != 0) {
            (bool ok,) = msg.sender.call{value: driftNativeWei}("");
            require(ok, "drift send");
        }
        if (params.zeroForOne) {
            uint256 out = (consumed * buyRateWad) / 1e18;
            _owedNative = consumed;
            return _toBalanceDelta(-int256(consumed), int256(out));
        }
        uint256 outNative = (consumed * sellRateWad) / 1e18;
        _owedToken = consumed;
        return _toBalanceDelta(int256(outNative), -int256(consumed));
    }

    function take(address currency, address to, uint256 amount) external {
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "native take");
        } else {
            require(currency == address(token), "take currency");
            token.mint(to, amount);
        }
    }

    function sync(address currency) external {
        require(currency == address(token), "sync currency");
        _synced = token.balanceOf(address(this));
        _syncedSet = true;
    }

    function settle() external payable returns (uint256 paid) {
        if (msg.value != 0) {
            require(msg.value == _owedNative, "native settle");
            _owedNative = 0;
            return msg.value;
        }
        require(_syncedSet, "settle before sync");
        paid = token.balanceOf(address(this)) - _synced;
        require(paid == _owedToken, "token settle");
        _owedToken = 0;
        _syncedSet = false;
    }

    function extsload(bytes32) external view returns (bytes32) {
        return bytes32(uint256(sqrtPrice));
    }

    function _toBalanceDelta(int256 amount0, int256 amount1) private pure returns (int256) {
        return (amount0 << 128) | int256(uint256(uint128(uint256(amount1))));
    }

    receive() external payable {}
}

contract RobinhoodV4NativePoolAdapterTest is Test {
    uint24 internal constant FEE = 2500;
    int24 internal constant TICK_SPACING = 25;

    MockWrappedNative internal weth;
    MockERC20 internal token;
    MockV4NativePoolManager internal manager;
    RobinhoodV4NativePoolAdapter internal adapter;
    address internal zap = address(0xA11CE);

    function setUp() public {
        vm.chainId(4663);
        weth = new MockWrappedNative();
        token = new MockERC20("Hookr.fun", "HOOKR", 18);
        manager = new MockV4NativePoolManager();
        manager.setToken(token);
        // Enough native inventory to pay out the largest fuzzed sell (500k tokens at 0.5 rate).
        vm.deal(address(manager), 300_000 ether);
        adapter = new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), address(token), FEE, TICK_SPACING, _poolId(address(token))
        );

        // The zap holds funded balances and native backing exists for every wrapped unit.
        vm.deal(address(weth), 1_000 ether);
        weth.mint(zap, 100 ether);
        token.mint(zap, 1_000_000 ether);
        vm.prank(zap);
        weth.approve(address(adapter), type(uint256).max);
        vm.prank(zap);
        token.approve(address(adapter), type(uint256).max);
    }

    function _poolId(address currency1) internal pure returns (bytes32) {
        return keccak256(abi.encode(address(0), currency1, FEE, TICK_SPACING, address(0)));
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_pinsPoolIdentity() public view {
        assertEq(adapter.poolId(), _poolId(address(token)));
        PoolKey memory key = adapter.poolKey();
        assertEq(key.currency0, address(0));
        assertEq(key.currency1, address(token));
        assertEq(key.fee, FEE);
        assertEq(key.tickSpacing, TICK_SPACING);
        assertEq(key.hooks, address(0));
    }

    function test_constructor_revertsOffRobinhoodChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.WrongChain.selector, 1));
        new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), address(token), FEE, TICK_SPACING, _poolId(address(token))
        );
    }

    function test_constructor_revertsOnZeroAddresses() public {
        vm.expectRevert(RobinhoodV4NativePoolAdapter.ZeroAddress.selector);
        new RobinhoodV4NativePoolAdapter(
            address(0), address(manager), address(token), FEE, TICK_SPACING, _poolId(address(token))
        );
        vm.expectRevert(RobinhoodV4NativePoolAdapter.ZeroAddress.selector);
        new RobinhoodV4NativePoolAdapter(
            address(weth), address(0), address(token), FEE, TICK_SPACING, _poolId(address(token))
        );
        vm.expectRevert(RobinhoodV4NativePoolAdapter.ZeroAddress.selector);
        new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), address(0), FEE, TICK_SPACING, _poolId(address(0))
        );
    }

    function test_constructor_revertsWhenWethIsCurrency1() public {
        vm.expectRevert(RobinhoodV4NativePoolAdapter.CurrenciesEqual.selector);
        new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), address(weth), FEE, TICK_SPACING, _poolId(address(weth))
        );
    }

    function test_constructor_revertsOnBadTickSpacing() public {
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.InvalidTickSpacing.selector, int24(0)));
        new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), address(token), FEE, 0, _poolId(address(token))
        );
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.InvalidTickSpacing.selector, int24(32768)));
        new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), address(token), FEE, 32768, _poolId(address(token))
        );
    }

    function test_constructor_refusesDynamicAndOversizedFees() public {
        // The dynamic-fee flag (0x800000) sits above MAX_LP_FEE, so one static bound refuses both.
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.InvalidFee.selector, uint24(0x800000)));
        new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), address(token), 0x800000, TICK_SPACING, _poolId(address(token))
        );
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.InvalidFee.selector, uint24(1_000_001)));
        new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), address(token), 1_000_001, TICK_SPACING, _poolId(address(token))
        );
    }

    function test_constructor_revertsOnCodelessDependencies() public {
        address codeless = address(0xC0DE);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.NoCode.selector, codeless));
        new RobinhoodV4NativePoolAdapter(
            codeless, address(manager), address(token), FEE, TICK_SPACING, _poolId(address(token))
        );
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.NoCode.selector, codeless));
        new RobinhoodV4NativePoolAdapter(
            address(weth), codeless, address(token), FEE, TICK_SPACING, _poolId(address(token))
        );
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.NoCode.selector, codeless));
        new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), codeless, FEE, TICK_SPACING, _poolId(codeless)
        );
    }

    function test_constructor_revertsOnPoolIdMismatch() public {
        bytes32 wrong = keccak256("not the pool");
        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.PoolIdMismatch.selector, wrong, _poolId(address(token)))
        );
        new RobinhoodV4NativePoolAdapter(address(weth), address(manager), address(token), FEE, TICK_SPACING, wrong);
    }

    function test_constructor_revertsWhilePoolUninitialized() public {
        manager.setSqrtPrice(0);
        vm.expectRevert(RobinhoodV4NativePoolAdapter.PoolNotInitialized.selector);
        new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), address(token), FEE, TICK_SPACING, _poolId(address(token))
        );
    }

    // ---------------------------------------------------------------- inputs

    function test_execute_rejectsUnsupportedToken() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.UnsupportedToken.selector, address(other)));
        vm.prank(zap);
        adapter.execute(address(other), 1 ether, "");
    }

    function test_execute_rejectsZeroAmount() public {
        vm.expectRevert(RobinhoodV4NativePoolAdapter.ZeroAmount.selector);
        vm.prank(zap);
        adapter.execute(address(weth), 0, "");
    }

    function test_execute_rejectsAmountAboveInt128() public {
        vm.expectRevert(RobinhoodV4NativePoolAdapter.AmountTooLarge.selector);
        vm.prank(zap);
        adapter.execute(address(weth), uint256(uint128(type(int128).max)) + 1, "");
    }

    function test_execute_rejectsMalformedData() public {
        vm.expectRevert(RobinhoodV4NativePoolAdapter.InvalidData.selector);
        vm.prank(zap);
        adapter.execute(address(weth), 1 ether, hex"01");
        vm.expectRevert(RobinhoodV4NativePoolAdapter.InvalidData.selector);
        vm.prank(zap);
        adapter.execute(address(weth), 1 ether, abi.encodePacked(uint256(1), uint8(0)));
    }

    function test_execute_rejectsOversizedMinAmountOut() public {
        vm.expectRevert(RobinhoodV4NativePoolAdapter.AmountTooLarge.selector);
        vm.prank(zap);
        adapter.execute(address(weth), 1 ether, abi.encode(uint256(type(uint128).max) + 1));
    }

    // ------------------------------------------------------------------- buy

    function test_buy_swapsExactInputAndForwardsMeasuredOutput() public {
        uint256 amountIn = 1 ether;
        uint256 wethBefore = weth.balanceOf(zap);
        vm.prank(zap);
        (address tokenOut, uint256 amountOut) = adapter.execute(address(weth), amountIn, "");

        assertEq(tokenOut, address(token));
        assertEq(amountOut, 2 ether); // buyRateWad = 2e18
        assertEq(token.balanceOf(zap) - 1_000_000 ether, amountOut);
        assertEq(weth.balanceOf(zap), wethBefore - amountIn);
        // Nothing rests in the adapter on any leg.
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, 0);
    }

    function test_buy_enforcesCallerFloor() public {
        vm.prank(zap);
        (, uint256 amountOut) = adapter.execute(address(weth), 1 ether, abi.encode(uint256(2 ether)));
        assertEq(amountOut, 2 ether);

        vm.expectRevert(
            abi.encodeWithSelector(
                RobinhoodV4NativePoolAdapter.InsufficientOutput.selector, uint256(2 ether) + 1, uint256(2 ether)
            )
        );
        vm.prank(zap);
        adapter.execute(address(weth), 1 ether, abi.encode(uint256(2 ether) + 1));
    }

    function test_buy_refusesPartialFill() public {
        manager.setConsumeBps(9_999);
        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.PartialFill.selector, 1 ether, 0.9999 ether)
        );
        vm.prank(zap);
        adapter.execute(address(weth), 1 ether, "");
    }

    function test_buy_refusesZeroOutput() public {
        manager.setRates(0, 5e17);
        // A zero output makes the swap delta non-positive on the output side.
        vm.expectRevert(RobinhoodV4NativePoolAdapter.BadSwapDelta.selector);
        vm.prank(zap);
        adapter.execute(address(weth), 1 ether, "");
    }

    function test_buy_refusesNativeDrift() public {
        manager.setDriftNativeWei(1);
        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.ResidualNative.selector, uint256(0), uint256(1))
        );
        vm.prank(zap);
        adapter.execute(address(weth), 1 ether, "");
    }

    // ------------------------------------------------------------------ sell

    function test_sell_swapsExactInputAndSettlesInWrappedNative() public {
        uint256 amountIn = 1_000 ether;
        uint256 tokenBefore = token.balanceOf(zap);
        uint256 wethBefore = weth.balanceOf(zap);
        vm.prank(zap);
        (address tokenOut, uint256 amountOut) = adapter.execute(address(token), amountIn, "");

        assertEq(tokenOut, address(weth));
        assertEq(amountOut, 500 ether); // sellRateWad = 5e17
        assertEq(weth.balanceOf(zap) - wethBefore, amountOut);
        assertEq(token.balanceOf(zap), tokenBefore - amountIn);
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, 0);
    }

    function test_sell_enforcesCallerFloor() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                RobinhoodV4NativePoolAdapter.InsufficientOutput.selector, uint256(500 ether) + 1, uint256(500 ether)
            )
        );
        vm.prank(zap);
        adapter.execute(address(token), 1_000 ether, abi.encode(uint256(500 ether) + 1));
    }

    function test_sell_refusesPartialFill() public {
        manager.setConsumeBps(5_000);
        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.PartialFill.selector, 1_000 ether, 500 ether)
        );
        vm.prank(zap);
        adapter.execute(address(token), 1_000 ether, "");
    }

    function test_sell_refusesFeeOnTransferInput() public {
        MockFeeOnTransferERC20 skimmed = new MockFeeOnTransferERC20();
        RobinhoodV4NativePoolAdapter skimmedAdapter = new RobinhoodV4NativePoolAdapter(
            address(weth), address(manager), address(skimmed), FEE, TICK_SPACING, _poolId(address(skimmed))
        );
        skimmed.mint(zap, 10 ether);
        vm.prank(zap);
        skimmed.approve(address(skimmedAdapter), type(uint256).max);
        manager.setToken(MockERC20(address(skimmed)));

        vm.expectRevert(
            abi.encodeWithSelector(RobinhoodV4NativePoolAdapter.InexactInputTransfer.selector, 1 ether, 0.99 ether)
        );
        vm.prank(zap);
        skimmedAdapter.execute(address(skimmed), 1 ether, "");
        manager.setToken(token);
    }

    // ------------------------------------------------- unlock/callback safety

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(RobinhoodV4NativePoolAdapter.OnlyPoolManager.selector);
        adapter.unlockCallback(abi.encode(true, uint256(1)));
    }

    function test_unlockCallback_refusesWithoutOpenSwap() public {
        vm.expectRevert(RobinhoodV4NativePoolAdapter.UnexpectedUnlock.selector);
        vm.prank(address(manager));
        adapter.unlockCallback(abi.encode(true, uint256(1)));
    }

    function test_execute_refusesManagerThatSkipsCallback() public {
        manager.setSkipCallback(true);
        vm.expectRevert(RobinhoodV4NativePoolAdapter.UnexpectedUnlock.selector);
        vm.prank(zap);
        adapter.execute(address(weth), 1 ether, "");
    }

    function test_execute_refusesTamperedCallbackData() public {
        manager.setTamperCallback(true);
        vm.expectRevert(RobinhoodV4NativePoolAdapter.UnexpectedUnlock.selector);
        vm.prank(zap);
        adapter.execute(address(weth), 1 ether, "");
    }

    function test_execute_holdsReentrancyMutexThroughUnlock() public {
        manager.setReenterDuringUnlock(true);
        vm.expectRevert(RobinhoodV4NativePoolAdapter.Reentrancy.selector);
        vm.prank(zap);
        adapter.execute(address(weth), 1 ether, "");
    }

    function test_receive_refusesUnknownNativeSenders() public {
        vm.deal(zap, 1 ether);
        vm.expectRevert(RobinhoodV4NativePoolAdapter.NativeNotAccepted.selector);
        vm.prank(zap);
        (bool ok,) = address(adapter).call{value: 1}("");
        ok; // silence the unused warning; the expectRevert above is the assertion
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_buy_measuredOutputAndNoResidue(uint96 amountIn) public {
        amountIn = uint96(bound(amountIn, 1, 50 ether));
        vm.prank(zap);
        (, uint256 amountOut) = adapter.execute(address(weth), amountIn, "");
        assertEq(amountOut, (uint256(amountIn) * 2e18) / 1e18);
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, 0);
    }

    function testFuzz_sell_measuredOutputAndNoResidue(uint96 amountIn) public {
        amountIn = uint96(bound(amountIn, 2, 500_000 ether));
        vm.prank(zap);
        (, uint256 amountOut) = adapter.execute(address(token), amountIn, "");
        assertEq(amountOut, (uint256(amountIn) * 5e17) / 1e18);
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(token.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, 0);
    }
}
