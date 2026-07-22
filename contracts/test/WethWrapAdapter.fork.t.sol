// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test, stdError} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {IAdapter} from "../src/interfaces/IAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {SafeApprove} from "../src/libraries/SafeApprove.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

// ------------------------------------------------------------------------- //
// TEST-ONLY PROBES — NOT ADAPTERS, NOT SHIPPABLE, NEVER ALLOWLIST THESE      //
// ------------------------------------------------------------------------- //
// These three contracts exist to MEASURE the boundary that makes a WETH
// wrap/unwrap adapter inexpressible under OpenZap v1. None of them is a
// candidate for `src/adapters/`. `EthObserverProbe` is a WETH round-trip with
// no economic effect; `HonestUnwrapProbe` tells the truth and is therefore
// rejected by the core; `LyingUnwrapProbe` tells the exact lie a faked unwrap
// adapter would have to tell, and exists so the test suite can demonstrate
// that the core catches it. They live in the test tree on purpose.

/// @dev Pulls `amountIn` WETH from the caller and immediately returns it, while recording the native
///      balances observed at entry. Proves that a zap forwards zero native value to a step, so an
///      adapter can never obtain the ETH a `deposit()` would need.
contract EthObserverProbe is IAdapter {
    address public immutable weth;
    uint256 public selfBalanceAtEntry;
    uint256 public callerBalanceAtEntry;
    uint256 public callCount;

    constructor(address weth_) {
        weth = weth_;
    }

    function execute(address tokenIn, uint256 amountIn, bytes calldata)
        external
        returns (address tokenOut, uint256 amountOut)
    {
        selfBalanceAtEntry = address(this).balance;
        callerBalanceAtEntry = msg.sender.balance;
        callCount += 1;

        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        SafeApprove.safeTransfer(tokenIn, msg.sender, amountIn);
        return (tokenIn, amountIn);
    }
}

/// @dev The honest unwrap: pull WETH, `withdraw()` it, forward the native ETH to the caller, and
///      report the truth — `tokenOut == address(0)`, because native ETH has no ERC-20 address.
///      OpenZap rejects that return value unconditionally. That rejection is the finding.
contract HonestUnwrapProbe is IAdapter {
    address public immutable weth;
    uint256 private _entered;

    error Reentrancy();
    error NativeForwardFailed();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address weth_) {
        weth = weth_;
    }

    function execute(address tokenIn, uint256 amountIn, bytes calldata)
        external
        nonReentrant
        returns (address tokenOut, uint256 amountOut)
    {
        require(tokenIn == weth, "probe: not weth");
        uint256 ethBefore = address(this).balance;
        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        IWETH9(weth).withdraw(amountIn);
        uint256 gained = address(this).balance - ethBefore;
        (bool ok,) = payable(msg.sender).call{value: gained}("");
        if (!ok) revert NativeForwardFailed();
        return (address(0), gained); // native ETH is not an ERC-20; there is no honest non-zero address
    }

    receive() external payable {}
}

/// @dev The lie a faked unwrap adapter would have to tell: unwrap the WETH, push native ETH to the
///      zap, then claim `(WETH, amountIn)` as the step output. The per-step return check passes.
///      Settlement does not — the zap's WETH balance went DOWN, so `out = post - preOut` underflows.
contract LyingUnwrapProbe is IAdapter {
    address public immutable weth;

    error NativeForwardFailed();

    constructor(address weth_) {
        weth = weth_;
    }

    function execute(address tokenIn, uint256 amountIn, bytes calldata)
        external
        returns (address tokenOut, uint256 amountOut)
    {
        SafeApprove.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
        IWETH9(weth).withdraw(amountIn);
        (bool ok,) = payable(msg.sender).call{value: amountIn}("");
        if (!ok) revert NativeForwardFailed();
        return (weth, amountIn); // <-- the lie
    }

    receive() external payable {}
}

// ------------------------------------------------------------------------- //
// The proof                                                                  //
// ------------------------------------------------------------------------- //

/// @title WethWrapAdapterForkTest
/// @notice Fork proof, against live Base WETH9, that NEITHER direction of a WETH wrap/unwrap step is
///         expressible under the OpenZap v1 core — which is why `src/adapters/WethWrapAdapter.sol`
///         does not exist. Each test below pins one link in that argument to observable behaviour.
contract WethWrapAdapterForkTest is Test {
    uint256 internal constant BASE_CHAIN_ID = 8453;
    /// @dev Same block `test/BaseV3SwapAdapter.fork.t.sol` and `foundry.toml` pin, so one cache serves
    ///      every fork suite in the repo.
    uint256 internal constant FORK_BLOCK = 48_900_000;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant AMOUNT = 0.01 ether;

    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "OpenZapIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address recipient,address relayer,uint256 maxRelayerFee,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    AdapterRegistry internal registry;
    TokenAllowlist internal allowlist;
    OpenZapFactory internal factory;
    address internal owner;

    function setUp() public {
        // Always this suite's OWN fork at a pinned block, never an inherited ambient `--fork-url`.
        // An ambient fork is unpinned; Foundry writes no RPC disk cache for an unpinned fork, so every
        // run re-fetches WETH9 and the Aave/Uniswap state from a public endpoint until it answers
        // HTTP 429, which forge surfaces as a fake test failure. Pinned, it is fetched once and cached.
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")), FORK_BLOCK);
        assertEq(block.chainid, BASE_CHAIN_ID, "not on Base");

        owner = vm.addr(OWNER_PK);
        registry = new AdapterRegistry(address(this));
        allowlist = new TokenAllowlist(address(this));
        factory = new OpenZapFactory(registry, allowlist);
        allowlist.setToken(WETH, true);
    }

    // --------------------------------------------------------------------- //
    // 1. The token itself                                                    //
    // --------------------------------------------------------------------- //

    /// @notice 0x4200..0006 really is canonical WETH9 on Base, verified against the fork.
    function test_Weth9IsCanonicalWrapperOnBase() public view {
        assertGt(WETH.code.length, 0, "no code at WETH9");
        assertEq(IWETH9(WETH).name(), "Wrapped Ether");
        assertEq(IWETH9(WETH).symbol(), "WETH");
        assertEq(IWETH9(WETH).decimals(), 18);
        assertGt(IERC20(WETH).totalSupply(), 1_000 ether, "implausible WETH supply");
    }

    /// @notice WETH9 is exactly 1:1 in both directions: no fee, no rebase, no rounding. This is why a
    ///         WETH "swap" block can never produce an ERC-20 gain — there is nothing to gain.
    function test_Weth9WrapUnwrapIsExactlyOneToOne() public {
        address user = makeAddr("weth-user");
        vm.deal(user, 1 ether);

        vm.startPrank(user);
        IWETH9(WETH).deposit{value: AMOUNT}();
        assertEq(IERC20(WETH).balanceOf(user), AMOUNT, "deposit not 1:1");
        assertEq(user.balance, 1 ether - AMOUNT, "deposit consumed the wrong amount of ETH");

        IWETH9(WETH).withdraw(AMOUNT);
        assertEq(IERC20(WETH).balanceOf(user), 0, "withdraw left WETH dust");
        assertEq(user.balance, 1 ether, "withdraw not 1:1");
        vm.stopPrank();
    }

    // --------------------------------------------------------------------- //
    // 2. WRAP is not expressible: a step cannot take native ETH as input     //
    // --------------------------------------------------------------------- //

    /// @notice `initialize` rejects `tokenIn == address(0)` outright, so no policy can ever declare a
    ///         step whose input is native ETH. A wrap block has no way to name its input.
    function test_WrapCannotBeAStep_NativeTokenInRejectedAtInitialize() public {
        EthObserverProbe probe = new EthObserverProbe(WETH);
        registry.setAdapter(address(probe), true);

        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(probe),
            tokenIn: address(0), // native ETH
            spender: address(probe),
            amountIn: AMOUNT,
            data: ""
        });
        address[] memory tracked = new address[](1);
        tracked[0] = WETH;
        Policy memory p = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });

        vm.expectRevert(OpenZap.NativeTokenUnsupported.selector);
        factory.createZap(p, keccak256("weth-wrap-native-in"));
    }

    /// @notice `IAdapter.execute` is non-payable, so no caller — zap or otherwise — can attach the
    ///         value a `WETH.deposit{value: ...}()` would need. The ABI itself closes the door.
    function test_AdapterExecuteIsNonPayable_NoNativeValueCanReachIt() public {
        EthObserverProbe probe = new EthObserverProbe(WETH);
        vm.deal(address(this), 1 ether);

        (bool ok,) = address(probe).call{value: 1 wei}(
            abi.encodeWithSelector(IAdapter.execute.selector, WETH, uint256(1), bytes(""))
        );
        assertFalse(ok, "adapter accepted native value: the interface would have to be payable");
        assertEq(address(probe).balance, 0, "probe retained native value");
    }

    /// @notice A real `execute()` run on the fork: the zap holds 1 ETH, and the step still sees zero
    ///         native value and zero adapter balance. The zap's ETH is untouched and unreachable —
    ///         there is no code path from a zap's native balance into a step.
    function test_ZapForwardsZeroNativeValueAndCannotFundAWrap() public {
        EthObserverProbe probe = new EthObserverProbe(WETH);
        registry.setAdapter(address(probe), true);
        OpenZap zap = _createZap(address(probe), keccak256("weth-observer"));

        _fundWeth(address(zap), AMOUNT);
        vm.deal(address(this), 1 ether);
        (bool sent,) = payable(address(zap)).call{value: 1 ether}(""); // exercise receive()
        assertTrue(sent, "zap refused a native deposit");
        assertEq(address(zap).balance, 1 ether);

        OpenZapIntent memory it = _intent(zap, WETH, 0);
        vm.prank(makeAddr("relayer"));
        zap.execute(it, _sign(it));

        assertEq(probe.callCount(), 1, "step did not run");
        assertEq(probe.selfBalanceAtEntry(), 0, "adapter somehow held native ETH");
        assertEq(address(probe).balance, 0, "adapter retained native ETH");
        assertEq(probe.callerBalanceAtEntry(), 1 ether, "zap's ETH changed during the step");
        assertEq(address(zap).balance, 1 ether, "execute moved the zap's native ETH");
    }

    // --------------------------------------------------------------------- //
    // 3. UNWRAP is not expressible: native ETH cannot be a step output       //
    // --------------------------------------------------------------------- //

    /// @notice The honest unwrap adapter returns `tokenOut == address(0)` because that is the truth.
    ///         The core rejects it in the per-step check, before settlement is even reached.
    function test_HonestUnwrapAdapterIsRejectedByStepCheck() public {
        HonestUnwrapProbe probe = new HonestUnwrapProbe(WETH);
        registry.setAdapter(address(probe), true);
        OpenZap zap = _createZap(address(probe), keccak256("weth-unwrap-honest"));
        _fundWeth(address(zap), AMOUNT);

        OpenZapIntent memory it = _intent(zap, WETH, 0);
        vm.expectRevert(abi.encodeWithSelector(OpenZap.InvalidAdapterResult.selector, 0, address(0), AMOUNT));
        vm.prank(makeAddr("relayer"));
        zap.execute(it, _sign(it));
    }

    /// @notice And the lie does not work either. An adapter that unwraps and then claims WETH as its
    ///         output clears the per-step check, and settlement underflows on `post - preOut` because
    ///         the zap's WETH balance FELL. This is the guardrail that makes faking it impossible.
    function test_LyingUnwrapAdapterUnderflowsSettlement() public {
        LyingUnwrapProbe probe = new LyingUnwrapProbe(WETH);
        registry.setAdapter(address(probe), true);
        OpenZap zap = _createZap(address(probe), keccak256("weth-unwrap-lying"));
        _fundWeth(address(zap), AMOUNT);

        OpenZapIntent memory it = _intent(zap, WETH, 0);
        vm.expectRevert(stdError.arithmeticError);
        vm.prank(makeAddr("relayer"));
        zap.execute(it, _sign(it));
    }

    /// @notice Native ETH cannot be named as `outAsset`: it is unallowlistable, and the settlement
    ///         check rejects it before any step runs.
    function test_NativeEthCannotBeOutAsset() public {
        EthObserverProbe probe = new EthObserverProbe(WETH);
        registry.setAdapter(address(probe), true);
        OpenZap zap = _createZap(address(probe), keccak256("weth-out-native"));
        _fundWeth(address(zap), AMOUNT);

        vm.expectRevert(TokenAllowlist.ZeroAddress.selector);
        allowlist.setToken(address(0), true);

        OpenZapIntent memory it = _intent(zap, address(0), 0);
        vm.expectRevert(abi.encodeWithSelector(OpenZap.TokenNotAllowed.selector, address(0)));
        vm.prank(makeAddr("relayer"));
        zap.execute(it, _sign(it));
    }

    // --------------------------------------------------------------------- //
    // 4. Consequence: native ETH in a zap is recoverable, but not routable   //
    // --------------------------------------------------------------------- //

    /// @notice A zap CAN hold native ETH (`receive()` accepts it) and `emergencyExit` returns it to
    ///         the owner — but that is the only native path in the contract. ETH sent to a capsule is
    ///         recoverable, never routable. The front end must wrap in the user's wallet, not here.
    function test_NativeEthInAZapIsRecoverableOnlyViaEmergencyExit() public {
        EthObserverProbe probe = new EthObserverProbe(WETH);
        registry.setAdapter(address(probe), true);
        OpenZap zap = _createZap(address(probe), keccak256("weth-recovery"));

        vm.deal(address(this), 3 ether);
        (bool sent,) = payable(address(zap)).call{value: 2 ether}("");
        assertTrue(sent);
        assertEq(address(zap).balance, 2 ether);

        uint256 ownerBefore = owner.balance;
        vm.prank(owner);
        zap.emergencyExit(new address[](0)); // empty asset list still drains native

        assertEq(address(zap).balance, 0, "native ETH stranded in the zap");
        assertEq(owner.balance, ownerBefore + 2 ether, "owner did not receive the native balance");
    }

    // --------------------------------------------------------------------- //
    // 5. Adapter hygiene the unwrap mechanics would have had to satisfy      //
    // --------------------------------------------------------------------- //

    /// @notice Called directly (outside a zap, the only way it can run at all), the unwrap mechanics
    ///         are clean: exact pull, zero residual allowance, zero WETH dust, zero retained ETH,
    ///         and a 1:1 native payout. The mechanics were never the problem — the settlement model
    ///         is. This is what a v2 core with native settlement would inherit.
    function test_UnwrapMechanicsLeaveNoDustAndNoResidualAllowance() public {
        HonestUnwrapProbe probe = new HonestUnwrapProbe(WETH);
        address caller = makeAddr("direct-caller");
        vm.deal(caller, 1 ether);

        vm.startPrank(caller);
        IWETH9(WETH).deposit{value: AMOUNT}();
        IERC20(WETH).approve(address(probe), AMOUNT);
        uint256 ethBefore = caller.balance;

        (address tokenOut, uint256 amountOut) = probe.execute(WETH, AMOUNT, "");
        vm.stopPrank();

        assertEq(tokenOut, address(0), "unwrap must report native ETH honestly");
        assertEq(amountOut, AMOUNT, "unwrap must report the measured amount");

        // no residual allowance on any path
        assertEq(IERC20(WETH).allowance(caller, address(probe)), 0, "residual caller -> adapter allowance");
        assertEq(IERC20(WETH).allowance(address(probe), WETH), 0, "adapter granted a standing allowance");
        // no dust, no retained funds
        assertEq(IERC20(WETH).balanceOf(address(probe)), 0, "adapter retained WETH");
        assertEq(address(probe).balance, 0, "adapter retained ETH");
        // exact 1:1 settlement to the caller
        assertEq(IERC20(WETH).balanceOf(caller), 0, "caller kept WETH");
        assertEq(caller.balance, ethBefore + AMOUNT, "caller did not receive exactly amountIn in ETH");
    }

    // --------------------------------------------------------------------- //
    // helpers                                                                //
    // --------------------------------------------------------------------- //

    function _createZap(address adapter, bytes32 salt) internal returns (OpenZap) {
        Step[] memory steps = new Step[](1);
        steps[0] = Step({adapter: adapter, tokenIn: WETH, spender: adapter, amountIn: AMOUNT, data: ""});
        address[] memory tracked = new address[](1);
        tracked[0] = WETH;
        Policy memory p = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
        return OpenZap(payable(factory.createZap(p, salt)));
    }

    function _fundWeth(address to, uint256 amount) internal {
        address funder = makeAddr("weth-funder");
        vm.deal(funder, amount + 1 ether);
        vm.startPrank(funder);
        IWETH9(WETH).deposit{value: amount}();
        IERC20(WETH).transfer(to, amount);
        vm.stopPrank();
    }

    function _intent(OpenZap zap, address outAsset, uint256 minOut) internal view returns (OpenZapIntent memory) {
        return OpenZapIntent({
            zap: address(zap),
            chainId: block.chainid,
            nonce: 1,
            validAfter: 0,
            deadline: uint64(block.timestamp + 1 hours),
            recipient: owner,
            relayer: address(0),
            maxRelayerFee: 0,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: outAsset,
            minOut: minOut
        });
    }

    function _sign(OpenZapIntent memory it) internal view returns (bytes memory) {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("1"), block.chainid, it.zap));
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                it.zap,
                it.chainId,
                it.nonce,
                it.validAfter,
                it.deadline,
                it.recipient,
                it.relayer,
                it.maxRelayerFee,
                it.maxGas,
                it.maxFeePerGas,
                it.policyHash,
                it.outAsset,
                it.minOut
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
