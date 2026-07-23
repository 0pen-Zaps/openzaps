// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZapV2} from "../src/v2/OpenZapV2.sol";
import {OpenZapFactoryV2} from "../src/v2/OpenZapFactoryV2.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {IAdapter} from "../src/interfaces/IAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {MockRevertingAdapter} from "./mocks/MockRevertingAdapter.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";
import {MockFeeOnTransferERC20} from "./mocks/MockFeeOnTransferERC20.sol";

// --------------------------------------------------------------------------- //
// Inline mocks specific to the V2 surface                                     //
// --------------------------------------------------------------------------- //

/// @notice Attempts to re-enter the calling V2 zap's `execute` mid-step. Must be rejected by the
///         reentrancy guard before any state change (invariant I-AUTH-1).
contract V2ReentrantAdapter is IAdapter {
    function execute(address, uint256, bytes calldata) external override returns (address, uint256) {
        OpenZapIntent memory dummy;
        OpenZapV2(payable(msg.sender)).execute(dummy, ""); // reverts Reentrancy() -> bubbles up
        return (address(0), 0);
    }
}

/// @notice Returns a (zero, zero) result to prove the postcondition check rejects it (I-FLOW).
contract V2InvalidResultAdapter is IAdapter {
    function execute(address, uint256, bytes calldata) external pure override returns (address, uint256) {
        return (address(0), 0);
    }
}

// --------------------------------------------------------------------------- //
// Shared fixture                                                              //
// --------------------------------------------------------------------------- //

/// @dev Shared fixture for the V2 candidate: deploys governance + the V2 factory, creates a funded
///      1-step fixed swap zap (identical shape to the v1 fixture so the ported invariant/auth/approval
///      suites map 1:1), and provides an EIP-712 signing helper computed independently of the contract.
///      Note the domain VERSION is "2" — a v2 clone signs under a distinct domain version from v1.
abstract contract V2BaseTest is Test {
    // Independent copies of the contract's typehashes (a divergence would break signature tests).
    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "OpenZapIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address recipient,address relayer,uint256 maxRelayerFee,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 internal constant BALANCE_RELATIVE = type(uint256).max;

    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;
    address internal recipient = address(0xBEEF);
    address internal relayer = address(0xFEE);

    AdapterRegistry internal registry;
    TokenAllowlist internal allowlist;
    OpenZapFactoryV2 internal factory;
    MockERC20 internal tokenIn;
    MockERC20 internal tokenOut;
    MockSwapAdapter internal adapter;
    OpenZapV2 internal zap;

    uint256 internal constant AMOUNT_IN = 100e18;
    uint256 internal constant FEE_CAP = 5e18;

    /// @dev Base mainnet, and the block every fork suite in this repo pins.
    uint256 internal constant BASE_CHAIN_ID = 8453;
    uint256 internal constant BASE_FORK_BLOCK = 48_900_000;

    function setUp() public virtual {
        // Mock-only suite; the conditional re-pin makes it deterministic under `--fork-url <base>`
        // exactly as the v1 Base.t.sol fixture does (see that file for the full rationale).
        if (block.chainid == BASE_CHAIN_ID) {
            vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")), BASE_FORK_BLOCK);
        }

        owner = vm.addr(OWNER_PK);

        registry = new AdapterRegistry(address(this));
        allowlist = new TokenAllowlist(address(this));
        factory = new OpenZapFactoryV2(registry, allowlist);

        tokenIn = new MockERC20("In", "IN", 18);
        tokenOut = new MockERC20("Out", "OUT", 18);
        allowlist.setToken(address(tokenIn), true);
        allowlist.setToken(address(tokenOut), true);

        adapter = new MockSwapAdapter();
        registry.setAdapter(address(adapter), true);
        tokenOut.mint(address(adapter), 1_000_000e18); // adapter reserve

        zap = OpenZapV2(payable(factory.createZap(_defaultPolicy(), bytes32("zap-1"))));
        tokenIn.mint(address(zap), AMOUNT_IN);
    }

    // ---- token helpers for multi-step chains ----

    function _newToken(string memory sym) internal returns (MockERC20 t) {
        t = new MockERC20(sym, sym, 18);
        allowlist.setToken(address(t), true);
    }

    function _fundAdapterReserve(MockERC20 t, uint256 amt) internal {
        t.mint(address(adapter), amt);
    }

    // ---- policy / intent builders ----

    function _defaultPolicy() internal view returns (Policy memory p) {
        address[] memory tracked = new address[](2);
        tracked[0] = address(tokenIn);
        tracked[1] = address(tokenOut);

        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(adapter),
            tokenIn: address(tokenIn),
            spender: address(adapter),
            amountIn: AMOUNT_IN,
            data: abi.encode(address(tokenOut), uint256(1e18)) // 1:1 rate
        });

        p = Policy({
            owner: owner,
            recipient: recipient,
            maxRelayerFeeCap: FEE_CAP,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
    }

    /// @dev A single swap step. `amt == BALANCE_RELATIVE` requests balance-relative input.
    function _swapStep(address tIn, address tOut, uint256 amt, uint256 rate) internal view returns (Step memory) {
        return Step({
            adapter: address(adapter),
            tokenIn: tIn,
            spender: address(adapter),
            amountIn: amt,
            data: abi.encode(tOut, rate)
        });
    }

    function _defaultIntent() internal view returns (OpenZapIntent memory it) {
        it = OpenZapIntent({
            zap: address(zap),
            chainId: block.chainid,
            nonce: 1,
            validAfter: 0,
            deadline: uint64(block.timestamp + 1 hours),
            recipient: recipient,
            relayer: relayer,
            maxRelayerFee: 1e18,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: address(tokenOut),
            minOut: 99e18 // 100 in @1:1 minus 1 fee
        });
    }

    function _digest(OpenZapIntent memory it, address verifyingZap) internal view returns (bytes32) {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("2"), block.chainid, verifyingZap));
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
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _signIntent(uint256 pk, OpenZapIntent memory it) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(it, it.zap));
        return abi.encodePacked(r, s, v);
    }
}

// =========================================================================== //
// AUTH — signature binding, replay, expiry, chain/zap/policy binding, gas cap //
// =========================================================================== //

contract V2AuthTest is V2BaseTest {
    function test_happyPath_executes() public {
        OpenZapIntent memory it = _defaultIntent();
        vm.prank(relayer);
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(recipient), 99e18, "recipient net");
        assertEq(tokenOut.balanceOf(relayer), 1e18, "relayer fee");
        assertEq(tokenIn.allowance(address(zap), address(adapter)), 0, "approval reset");
    }

    function test_contractDigestMatchesIndependentDigest() public view {
        OpenZapIntent memory it = _defaultIntent();
        assertEq(zap.hashIntent(it), _digest(it, address(zap)), "EIP-712 digest divergence");
    }

    function test_domainVersionIsTwo() public view {
        // The v2 signing surface is explicitly scoped to domain version "2".
        bytes32 expected =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("2"), block.chainid, address(zap)));
        assertEq(zap.domainSeparator(), expected, "domain must be version 2");
    }

    function test_rejects_wrongPolicyHash() public {
        OpenZapIntent memory it = _defaultIntent();
        it.policyHash = bytes32(uint256(0xdead));
        vm.expectRevert(OpenZapV2.PolicyMismatch.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_replayNonce() public {
        OpenZapIntent memory it = _defaultIntent();
        bytes memory sig = _signIntent(OWNER_PK, it);
        zap.execute(it, sig);
        tokenIn.mint(address(zap), AMOUNT_IN); // refund so only the nonce can block it
        vm.expectRevert(OpenZapV2.NonceReplay.selector);
        zap.execute(it, sig);
    }

    function test_rejects_expiredDeadline() public {
        OpenZapIntent memory it = _defaultIntent();
        it.deadline = uint64(block.timestamp);
        bytes memory sig = _signIntent(OWNER_PK, it);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(OpenZapV2.Expired.selector);
        zap.execute(it, sig);
    }

    function test_rejects_notYetValid() public {
        OpenZapIntent memory it = _defaultIntent();
        it.validAfter = uint64(block.timestamp + 100);
        vm.expectRevert(OpenZapV2.NotYetValid.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_wrongSigner() public {
        OpenZapIntent memory it = _defaultIntent();
        vm.expectRevert(OpenZapV2.BadSignature.selector);
        zap.execute(it, _signIntent(0xB0B, it)); // not the owner key
    }

    function test_rejects_wrongChainId() public {
        OpenZapIntent memory it = _defaultIntent();
        it.chainId = 999;
        vm.expectRevert(OpenZapV2.WrongChain.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_wrongZap() public {
        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(0x1234);
        vm.expectRevert(OpenZapV2.WrongZap.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_gasPriceAboveCap() public {
        OpenZapIntent memory it = _defaultIntent();
        it.maxFeePerGas = 1;
        bytes memory sig = _signIntent(OWNER_PK, it);
        vm.txGasPrice(2);
        vm.expectRevert(OpenZapV2.GasPriceTooHigh.selector);
        zap.execute(it, sig);
    }

    function test_rejects_feeAboveCap() public {
        OpenZapIntent memory it = _defaultIntent();
        it.maxRelayerFee = FEE_CAP + 1;
        vm.expectRevert(OpenZapV2.FeeAboveCap.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_wrongRecipient() public {
        OpenZapIntent memory it = _defaultIntent();
        it.recipient = address(0x9999);
        vm.expectRevert(OpenZapV2.WrongRecipient.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_gasLimitAboveSignedCap() public {
        OpenZapIntent memory it = _defaultIntent();
        it.maxGas = 100_000; // the test forwards far more gas than this
        vm.expectRevert(OpenZapV2.GasLimitTooHigh.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_erc1271_walletSigner() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(OWNER_PK));
        Policy memory p = _defaultPolicy();
        p.owner = address(wallet);
        OpenZapV2 z2 = OpenZapV2(payable(factory.createZap(p, bytes32("zap-1271"))));
        tokenIn.mint(address(z2), AMOUNT_IN);

        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(z2);
        it.policyHash = z2.policyHash();
        vm.prank(relayer);
        z2.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(recipient), 99e18);
    }

    function test_erc1271_rejectsForeignSigner() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(OWNER_PK));
        Policy memory p = _defaultPolicy();
        p.owner = address(wallet);
        OpenZapV2 z2 = OpenZapV2(payable(factory.createZap(p, bytes32("zap-1271b"))));
        tokenIn.mint(address(z2), AMOUNT_IN);

        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(z2);
        it.policyHash = z2.policyHash();
        vm.expectRevert(OpenZapV2.BadSignature.selector);
        z2.execute(it, _signIntent(0xB0B, it));
    }
}

// =========================================================================== //
// APPR + FLOW — exact-approval reset; net-of-fee min-out; bounded relayer fee  //
// =========================================================================== //

contract V2ApprovalFlowTest is V2BaseTest {
    function test_approvalResetAfterSuccess() public {
        OpenZapIntent memory it = _defaultIntent();
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenIn.allowance(address(zap), address(adapter)), 0);
    }

    function test_approvalResetAfterRevert() public {
        MockRevertingAdapter rev = new MockRevertingAdapter();
        registry.setAdapter(address(rev), true);

        Policy memory p = _defaultPolicy();
        p.steps[0].adapter = address(rev);
        p.steps[0].spender = address(rev);
        OpenZapV2 z2 = OpenZapV2(payable(factory.createZap(p, bytes32("rev"))));
        tokenIn.mint(address(z2), AMOUNT_IN);

        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(z2);
        it.policyHash = z2.policyHash();
        bytes memory sig = _signIntent(OWNER_PK, it);

        vm.expectRevert(MockRevertingAdapter.AdapterReverted.selector);
        z2.execute(it, sig);
        assertEq(tokenIn.allowance(address(z2), address(rev)), 0, "no residual approval on revert");
    }

    function test_minOutEnforced_netOfFee() public {
        OpenZapIntent memory it = _defaultIntent();
        it.minOut = 100e18; // gross is 100, net of 1 fee is 99 -> must revert
        vm.expectRevert(OpenZapV2.MinOutNotMet.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_feePaidBounded_recipientNet() public {
        OpenZapIntent memory it = _defaultIntent();
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(relayer), 1e18);
        assertEq(tokenOut.balanceOf(recipient), 99e18);
    }

    function test_noFeeWhenRelayerZero() public {
        OpenZapIntent memory it = _defaultIntent();
        it.relayer = address(0);
        it.maxRelayerFee = 0;
        it.minOut = 100e18;
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(recipient), 100e18);
        assertEq(tokenOut.balanceOf(relayer), 0);
    }

    function test_feeAtCap_recipientNet() public {
        OpenZapIntent memory it = _defaultIntent();
        it.maxRelayerFee = FEE_CAP; // 5e18
        it.minOut = 95e18;
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(relayer), 5e18);
        assertEq(tokenOut.balanceOf(recipient), 95e18);
    }
}

// =========================================================================== //
// ISO + TOK — impl bricked, init once/factory-only, isolation, curated tokens  //
// =========================================================================== //

contract V2IsolationTest is V2BaseTest {
    function test_implementationIsBricked() public {
        address impl = factory.implementation();
        assertEq(OpenZapV2(payable(impl)).owner(), address(0), "impl must never be initialized");

        Policy memory p = _defaultPolicy();
        vm.expectRevert(OpenZapV2.NotFactory.selector);
        OpenZapV2(payable(impl)).initialize(p);

        vm.prank(address(factory));
        vm.expectRevert(OpenZapV2.AlreadyInitialized.selector);
        OpenZapV2(payable(impl)).initialize(p);
    }

    function test_initialize_onlyFactory() public {
        Policy memory p = _defaultPolicy();
        vm.expectRevert(OpenZapV2.NotFactory.selector);
        zap.initialize(p);
    }

    function test_initialize_twiceReverts() public {
        Policy memory p = _defaultPolicy();
        vm.prank(address(factory));
        vm.expectRevert(OpenZapV2.AlreadyInitialized.selector);
        zap.initialize(p);
    }

    function test_rejects_nonOptimizationPolicy() public {
        Policy memory p = _defaultPolicy();
        p.optimization = false;
        vm.expectRevert(OpenZapV2.NotOptimization.selector);
        factory.createZap(p, bytes32("noopt"));
    }

    function test_predictMatchesCreate() public {
        address predicted = factory.predict(_defaultPolicy(), bytes32("predict-1"));
        address created = factory.createZap(_defaultPolicy(), bytes32("predict-1"));
        assertEq(created, predicted);
    }

    function test_perCloneStorageIsolated() public {
        Policy memory p = _defaultPolicy();
        p.recipient = address(0x1111);
        OpenZapV2 z2 = OpenZapV2(payable(factory.createZap(p, bytes32("iso-2"))));
        assertEq(zap.recipient(), recipient);
        assertEq(z2.recipient(), address(0x1111));
        assertTrue(zap.policyHash() != z2.policyHash(), "distinct policies -> distinct hashes");
    }

    function test_init_rejectsNonAllowlistedTrackedAsset() public {
        MockERC20 rogue = new MockERC20("R", "R", 18);
        Policy memory p = _defaultPolicy();
        p.trackedAssets[0] = address(rogue);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.TokenNotAllowed.selector, address(rogue)));
        factory.createZap(p, bytes32("rogue-tracked"));
    }

    function test_init_rejectsFeeOnTransferToken() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20();
        Policy memory p = _defaultPolicy();
        p.steps[0].tokenIn = address(fot); // not on the curated allowlist
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.TokenNotAllowed.selector, address(fot)));
        factory.createZap(p, bytes32("fot"));
    }

    // ---- init hardening (ported from v1 production suite) ----

    function test_init_rejectsEmptyPolicy() public {
        Policy memory p = _defaultPolicy();
        p.steps = new Step[](0);
        vm.expectRevert(OpenZapV2.EmptyPolicy.selector);
        factory.createZap(p, bytes32("empty"));
    }

    function test_init_rejectsZeroAmountStep() public {
        Policy memory p = _defaultPolicy();
        p.steps[0].amountIn = 0;
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.InvalidStep.selector, 0));
        factory.createZap(p, bytes32("zero-amount"));
    }

    function test_init_rejectsExternalSpender() public {
        Policy memory p = _defaultPolicy();
        p.steps[0].spender = address(0xCAFE);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.InvalidStep.selector, 0));
        factory.createZap(p, bytes32("wrong-spender"));
    }

    function test_init_rejectsNativeStep() public {
        Policy memory p = _defaultPolicy();
        p.steps[0].tokenIn = address(0);
        vm.expectRevert(OpenZapV2.NativeTokenUnsupported.selector);
        factory.createZap(p, bytes32("native"));
    }

    function test_init_rejectsDuplicateTrackedAsset() public {
        Policy memory p = _defaultPolicy();
        p.trackedAssets[1] = p.trackedAssets[0];
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.DuplicateTrackedAsset.selector, p.trackedAssets[0]));
        factory.createZap(p, bytes32("duplicate"));
    }

    function test_init_acceptsBalanceRelativeSentinel() public {
        // The sentinel (nonzero) clears the `amountIn == 0` guard and is stored verbatim.
        Policy memory p = _defaultPolicy();
        p.steps[0].amountIn = BALANCE_RELATIVE;
        OpenZapV2 z2 = OpenZapV2(payable(factory.createZap(p, bytes32("br-init"))));
        assertEq(z2.step(0).amountIn, BALANCE_RELATIVE, "sentinel frozen into policy");
    }

    function test_init_rejectsTooManySteps() public {
        Policy memory p = _defaultPolicy();
        Step memory s = p.steps[0];
        Step[] memory many = new Step[](17);
        for (uint256 i; i < 17; ++i) {
            many[i] = s;
        }
        p.steps = many;
        vm.expectRevert(OpenZapV2.PolicyTooLarge.selector);
        factory.createZap(p, bytes32("too-many-steps"));
    }
}

// =========================================================================== //
// REC — unconditional owner-only emergency exit, adapter-independent           //
// =========================================================================== //

contract V2RecoveryTest is V2BaseTest {
    function _inAssets() internal view returns (address[] memory a) {
        a = new address[](1);
        a[0] = address(tokenIn);
    }

    function test_emergencyExit_drainsToOwner() public {
        vm.prank(owner);
        zap.emergencyExit(_inAssets());
        assertEq(tokenIn.balanceOf(owner), AMOUNT_IN);
        assertEq(tokenIn.balanceOf(address(zap)), 0);
    }

    function test_emergencyExit_worksWhenAdapterRemoved() public {
        registry.setAdapter(address(adapter), false); // compromised protocol / governance halt
        vm.prank(owner);
        zap.emergencyExit(_inAssets());
        assertEq(tokenIn.balanceOf(owner), AMOUNT_IN, "exit must not depend on adapter health");
    }

    function test_emergencyExit_native() public {
        vm.deal(address(zap), 1 ether);
        address[] memory none = new address[](0);
        uint256 before = owner.balance;
        vm.prank(owner);
        zap.emergencyExit(none);
        assertEq(owner.balance, before + 1 ether);
    }

    function test_emergencyExit_onlyOwner() public {
        vm.expectRevert(OpenZapV2.NotOwner.selector);
        zap.emergencyExit(_inAssets());
    }

    function test_invalidateNonce_onlyOwner() public {
        vm.expectRevert(OpenZapV2.NotOwner.selector);
        zap.invalidateNonce(1);
    }

    function test_invalidateNonce_blocksHeldIntent() public {
        OpenZapIntent memory it = _defaultIntent();
        bytes memory sig = _signIntent(OWNER_PK, it);
        vm.prank(owner);
        zap.invalidateNonce(it.nonce);
        vm.expectRevert(OpenZapV2.NonceReplay.selector);
        zap.execute(it, sig);
    }

    function testFuzz_emergencyExit_fromArbitraryDeposits(uint96 a, uint96 b) public {
        tokenIn.mint(address(zap), a);
        tokenOut.mint(address(zap), b);
        uint256 inBal = tokenIn.balanceOf(address(zap));
        uint256 outBal = tokenOut.balanceOf(address(zap));

        address[] memory assets = new address[](2);
        assets[0] = address(tokenIn);
        assets[1] = address(tokenOut);

        vm.prank(owner);
        zap.emergencyExit(assets);

        assertEq(tokenIn.balanceOf(owner), inBal);
        assertEq(tokenOut.balanceOf(owner), outBal);
        assertEq(tokenIn.balanceOf(address(zap)), 0);
        assertEq(tokenOut.balanceOf(address(zap)), 0);
    }
}

// =========================================================================== //
// SURF — only allowlisted adapters reachable; reentrancy blocked; bad results   //
// =========================================================================== //

contract V2SurfaceTest is V2BaseTest {
    function test_deallowlistedAdapter_haltsExecution() public {
        registry.setAdapter(address(adapter), false); // governance kill-switch
        OpenZapIntent memory it = _defaultIntent();
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.AdapterNotAllowed.selector, address(adapter)));
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_init_rejectsNonAllowlistedAdapter() public {
        MockSwapAdapter rogue = new MockSwapAdapter();
        Policy memory p = _defaultPolicy();
        p.steps[0].adapter = address(rogue);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.AdapterNotAllowed.selector, address(rogue)));
        factory.createZap(p, bytes32("rogue-adapter"));
    }

    function test_reentrancyBlocked() public {
        V2ReentrantAdapter re = new V2ReentrantAdapter();
        registry.setAdapter(address(re), true);

        Policy memory p = _defaultPolicy();
        p.steps[0].adapter = address(re);
        p.steps[0].spender = address(re);
        OpenZapV2 z2 = OpenZapV2(payable(factory.createZap(p, bytes32("reentrant"))));
        tokenIn.mint(address(z2), AMOUNT_IN);

        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(z2);
        it.policyHash = z2.policyHash();
        bytes memory sig = _signIntent(OWNER_PK, it);

        vm.expectRevert(OpenZapV2.Reentrancy.selector);
        z2.execute(it, sig);
    }

    function test_execute_rejectsInvalidAdapterResult() public {
        V2InvalidResultAdapter invalid = new V2InvalidResultAdapter();
        registry.setAdapter(address(invalid), true);

        Policy memory p = _defaultPolicy();
        p.steps[0].adapter = address(invalid);
        p.steps[0].spender = address(invalid);
        OpenZapV2 z2 = OpenZapV2(payable(factory.createZap(p, bytes32("invalid-result"))));
        tokenIn.mint(address(z2), AMOUNT_IN);

        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(z2);
        it.policyHash = z2.policyHash();
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.InvalidAdapterResult.selector, 0, address(0), 0));
        z2.execute(it, _signIntent(OWNER_PK, it));
    }
}

// =========================================================================== //
// AUDIT — regression for the v1 multi-agent audit findings, retested on V2      //
// =========================================================================== //

contract V2AuditRegressionTest is V2BaseTest {
    // CRITICAL: create2-salt-collision-clone-hijack — address is bound to the full policy.
    function test_saltBoundToPolicy_preventsHijack() public {
        bytes32 salt = bytes32("victim-salt");
        Policy memory pVictim = _defaultPolicy();
        address victimAddr = factory.predict(pVictim, salt);

        Policy memory pAttacker = _defaultPolicy();
        pAttacker.owner = address(0xA77AC);
        pAttacker.recipient = address(0xA77AC);
        address attackerAddr = factory.predict(pAttacker, salt);

        assertTrue(victimAddr != attackerAddr, "distinct policy must map to distinct address");

        address deployed = factory.createZap(pAttacker, salt);
        assertEq(deployed, attackerAddr);
        assertTrue(deployed != victimAddr, "attacker cannot occupy victim's funded address");

        assertEq(factory.createZap(pVictim, salt), victimAddr);
    }

    // HIGH: full-balance settlement -> measured delta only; standing principal is never swept.
    function test_settlementUsesRunDeltaNotStandingBalance() public {
        tokenOut.mint(address(zap), 50e18); // pre-existing principal that must NOT leave
        OpenZapIntent memory it = _defaultIntent();
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(recipient), 99e18, "recipient gets run delta only");
        assertEq(tokenOut.balanceOf(relayer), 1e18);
        assertEq(tokenOut.balanceOf(address(zap)), 50e18, "standing principal untouched");
    }

    function test_settlement_revertsIfDeltaBelowMinOut() public {
        tokenOut.mint(address(zap), 200e18);
        OpenZapIntent memory it = _defaultIntent();
        it.minOut = 150e18; // only the 100e18 delta counts, not the 200e18 standing balance
        vm.expectRevert(OpenZapV2.MinOutNotMet.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    // HIGH/MEDIUM: zero owner is rejected at init (would otherwise brick recovery + permit junk sigs).
    function test_rejects_zeroOwnerPolicy() public {
        Policy memory p = _defaultPolicy();
        p.owner = address(0);
        vm.expectRevert(OpenZapV2.ZeroOwner.selector);
        factory.createZap(p, bytes32("zero-owner"));
    }

    // MEDIUM: outAsset must be on the curated allowlist at execution.
    function test_rejects_outAssetNotAllowlisted() public {
        MockERC20 rogue = new MockERC20("X", "X", 18);
        OpenZapIntent memory it = _defaultIntent();
        it.outAsset = address(rogue);
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.TokenNotAllowed.selector, address(rogue)));
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    // LOW: two-step governance ownership transfer on the kill-switch registries.
    function test_registry_twoStepOwnership() public {
        address newOwner = address(0xACE);
        registry.transferOwnership(newOwner);
        assertEq(registry.owner(), address(this), "owner unchanged until accepted");
        assertEq(registry.pendingOwner(), newOwner);

        vm.prank(newOwner);
        registry.acceptOwnership();
        assertEq(registry.owner(), newOwner);
        assertEq(registry.pendingOwner(), address(0));
    }
}

// =========================================================================== //
// BALANCE-RELATIVE — the one capability V2 adds. This is the headline suite.    //
// =========================================================================== //

contract V2BalanceRelativeTest is V2BaseTest {
    /// @dev Build and fund a fresh zap for a multi-step chain, returning it ready to execute.
    function _createZap(Policy memory p, bytes32 salt) internal returns (OpenZapV2 z) {
        z = OpenZapV2(payable(factory.createZap(p, salt)));
    }

    function _intentFor(OpenZapV2 z, address outAsset, uint256 minOut, uint256 fee, address rly)
        internal
        view
        returns (OpenZapIntent memory it)
    {
        it = OpenZapIntent({
            zap: address(z),
            chainId: block.chainid,
            nonce: 1,
            validAfter: 0,
            deadline: uint64(block.timestamp + 1 hours),
            recipient: recipient,
            relayer: rly,
            maxRelayerFee: fee,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: z.policyHash(),
            outAsset: outAsset,
            minOut: minOut
        });
    }

    /// THE thing v1 could not do: step 2 consumes exactly what step 1 produced, with zero stranding.
    function test_twoStepChain_balanceRelativeConsumesFullOutput_zeroStranding() public {
        MockERC20 tA = _newToken("A");
        MockERC20 tB = _newToken("B");
        MockERC20 tC = _newToken("C");
        _fundAdapterReserve(tB, 1_000_000e18);
        _fundAdapterReserve(tC, 1_000_000e18);

        Step[] memory steps = new Step[](2);
        steps[0] = _swapStep(address(tA), address(tB), AMOUNT_IN, 1e18); // fixed: 100 A -> 100 B
        steps[1] = _swapStep(address(tB), address(tC), BALANCE_RELATIVE, 1e18); // relative: all B -> C

        address[] memory tracked = new address[](3);
        (tracked[0], tracked[1], tracked[2]) = (address(tA), address(tB), address(tC));
        Policy memory p = Policy(owner, recipient, FEE_CAP, true, tracked, steps);

        OpenZapV2 z = _createZap(p, bytes32("br-2step"));
        tA.mint(address(z), AMOUNT_IN);

        OpenZapIntent memory it = _intentFor(z, address(tC), 99e18, 1e18, relayer);
        vm.prank(relayer);
        z.execute(it, _signIntent(OWNER_PK, it));

        assertEq(tC.balanceOf(recipient), 99e18, "recipient gets the full chained output, net of fee");
        assertEq(tC.balanceOf(relayer), 1e18, "relayer fee");
        assertEq(tB.balanceOf(address(z)), 0, "ZERO stranding: step 2 consumed 100% of step 1 output");
        assertEq(tA.balanceOf(address(z)), 0, "input fully spent by step 1");
        assertEq(tB.allowance(address(z), address(adapter)), 0, "balance-relative approval reset");
        assertEq(tA.allowance(address(z), address(adapter)), 0, "fixed approval reset");
    }

    /// The resolved amount is the RUNTIME balance, not a constant in the policy: step 0 produces 50 B
    /// at a 0.5 rate, and the balance-relative step 1 spends exactly that 50 — a value written nowhere
    /// in the signed policy (its amountIn field is the sentinel, not 50).
    function test_balanceRelative_sizesToRuntimeBalance_notAConstant() public {
        MockERC20 tA = _newToken("A2");
        MockERC20 tB = _newToken("B2");
        MockERC20 tC = _newToken("C2");
        _fundAdapterReserve(tB, 1_000_000e18);
        _fundAdapterReserve(tC, 1_000_000e18);

        Step[] memory steps = new Step[](2);
        steps[0] = _swapStep(address(tA), address(tB), AMOUNT_IN, 5e17); // fixed: 100 A @0.5 -> 50 B
        steps[1] = _swapStep(address(tB), address(tC), BALANCE_RELATIVE, 2e18); // relative: 50 B @2 -> 100 C

        address[] memory tracked = new address[](3);
        (tracked[0], tracked[1], tracked[2]) = (address(tA), address(tB), address(tC));
        Policy memory p = Policy(owner, recipient, FEE_CAP, true, tracked, steps);

        OpenZapV2 z = _createZap(p, bytes32("br-runtime"));
        tA.mint(address(z), AMOUNT_IN);

        assertEq(z.step(1).amountIn, BALANCE_RELATIVE, "policy stores the sentinel, not the runtime 50");

        OpenZapIntent memory it = _intentFor(z, address(tC), 100e18, 0, address(0));
        z.execute(it, _signIntent(OWNER_PK, it));

        assertEq(tC.balanceOf(recipient), 100e18, "consumed the runtime 50 B -> 100 C");
        assertEq(tB.balanceOf(address(z)), 0, "zero stranding");
    }

    /// A genuine mix: one fixed step feeding two chained balance-relative steps.
    function test_mixedFixedAndBalanceRelative_threeStep() public {
        MockERC20 tA = _newToken("A3");
        MockERC20 tB = _newToken("B3");
        MockERC20 tC = _newToken("C3");
        MockERC20 tD = _newToken("D3");
        _fundAdapterReserve(tB, 1_000_000e18);
        _fundAdapterReserve(tC, 1_000_000e18);
        _fundAdapterReserve(tD, 1_000_000e18);

        Step[] memory steps = new Step[](3);
        steps[0] = _swapStep(address(tA), address(tB), AMOUNT_IN, 1e18); // fixed
        steps[1] = _swapStep(address(tB), address(tC), BALANCE_RELATIVE, 1e18); // relative
        steps[2] = _swapStep(address(tC), address(tD), BALANCE_RELATIVE, 1e18); // relative

        address[] memory tracked = new address[](4);
        (tracked[0], tracked[1], tracked[2], tracked[3]) = (address(tA), address(tB), address(tC), address(tD));
        Policy memory p = Policy(owner, recipient, FEE_CAP, true, tracked, steps);

        OpenZapV2 z = _createZap(p, bytes32("br-3step"));
        tA.mint(address(z), AMOUNT_IN);

        OpenZapIntent memory it = _intentFor(z, address(tD), 100e18, 0, address(0));
        z.execute(it, _signIntent(OWNER_PK, it));

        assertEq(tD.balanceOf(recipient), 100e18, "full chain output");
        assertEq(tB.balanceOf(address(z)), 0, "no stranded B");
        assertEq(tC.balanceOf(address(z)), 0, "no stranded C");
        assertEq(tA.balanceOf(address(z)), 0, "no stranded A");
    }

    /// A balance-relative step over an EMPTY balance reverts cleanly — not a silent no-op, and not an
    /// opaque downstream InvalidAdapterResult.
    function test_balanceRelative_emptyBalance_revertsCleanly() public {
        MockERC20 tA = _newToken("Ae");
        MockERC20 tB = _newToken("Be");
        _fundAdapterReserve(tB, 1_000_000e18);

        Step[] memory steps = new Step[](1);
        steps[0] = _swapStep(address(tA), address(tB), BALANCE_RELATIVE, 1e18);

        address[] memory tracked = new address[](2);
        (tracked[0], tracked[1]) = (address(tA), address(tB));
        Policy memory p = Policy(owner, recipient, FEE_CAP, true, tracked, steps);

        OpenZapV2 z = _createZap(p, bytes32("br-empty"));
        // deliberately DO NOT fund the zap: balanceOf(tA) == 0

        OpenZapIntent memory it = _intentFor(z, address(tB), 0, 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.ZeroBalanceRelativeStep.selector, 0));
        z.execute(it, _signIntent(OWNER_PK, it));
    }

    /// A mid-chain balance-relative step whose input token was never produced reverts cleanly at that
    /// index, and the whole transaction rolls back with no residual approval.
    function test_balanceRelative_midChainEmptyBalance_revertsCleanly() public {
        MockERC20 tA = _newToken("Am");
        MockERC20 tB = _newToken("Bm");
        MockERC20 tC = _newToken("Cm"); // never produced by the chain
        _fundAdapterReserve(tB, 1_000_000e18);

        Step[] memory steps = new Step[](2);
        steps[0] = _swapStep(address(tA), address(tB), AMOUNT_IN, 1e18); // produces B
        steps[1] = _swapStep(address(tC), address(tB), BALANCE_RELATIVE, 1e18); // spends C — but there is none

        address[] memory tracked = new address[](3);
        (tracked[0], tracked[1], tracked[2]) = (address(tA), address(tB), address(tC));
        Policy memory p = Policy(owner, recipient, FEE_CAP, true, tracked, steps);

        OpenZapV2 z = _createZap(p, bytes32("br-midempty"));
        tA.mint(address(z), AMOUNT_IN);

        OpenZapIntent memory it = _intentFor(z, address(tB), 0, 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(OpenZapV2.ZeroBalanceRelativeStep.selector, 1));
        z.execute(it, _signIntent(OWNER_PK, it));

        assertEq(tA.allowance(address(z), address(adapter)), 0, "no residual approval after mid-chain revert");
    }

    /// With EVERY step balance-relative, the owner-signed minOut on the final output is the only amount
    /// bound left — and it still floors the whole chain. Passing case.
    function test_everyStepBalanceRelative_minOutFloor_passes() public {
        (OpenZapV2 z, MockERC20 tC) = _buildAllRelativeChain(bytes32("br-all-pass"));
        OpenZapIntent memory it = _intentFor(z, address(tC), 100e18, 0, address(0));
        z.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tC.balanceOf(recipient), 100e18, "full-relative chain clears its floor");
    }

    /// Same fully-relative chain, minOut set one wei above the achievable output: the final floor
    /// rejects it. This is the security crux — no per-step amount bound remains, yet the chain is still
    /// bounded.
    function test_everyStepBalanceRelative_minOutFloor_bounds() public {
        (OpenZapV2 z, MockERC20 tC) = _buildAllRelativeChain(bytes32("br-all-bound"));
        OpenZapIntent memory it = _intentFor(z, address(tC), 100e18 + 1, 0, address(0));
        vm.expectRevert(OpenZapV2.MinOutNotMet.selector);
        z.execute(it, _signIntent(OWNER_PK, it));
    }

    /// Selecting balance-relative vs fixed is frozen into the policy and hashed, so it lands at a
    /// distinct address and a submitter cannot flip the mode of a signed chain.
    function test_balanceRelativeMode_isPolicyBound() public {
        MockERC20 tA = _newToken("Ab");
        MockERC20 tB = _newToken("Bb");
        _fundAdapterReserve(tB, 1_000_000e18);
        address[] memory tracked = new address[](2);
        (tracked[0], tracked[1]) = (address(tA), address(tB));

        Step[] memory fixedSteps = new Step[](1);
        fixedSteps[0] = _swapStep(address(tA), address(tB), AMOUNT_IN, 1e18);
        Policy memory pFixed = Policy(owner, recipient, FEE_CAP, true, tracked, fixedSteps);

        Step[] memory relSteps = new Step[](1);
        relSteps[0] = _swapStep(address(tA), address(tB), BALANCE_RELATIVE, 1e18);
        Policy memory pRel = Policy(owner, recipient, FEE_CAP, true, tracked, relSteps);

        assertTrue(
            factory.predict(pFixed, bytes32("m")) != factory.predict(pRel, bytes32("m")),
            "fixed vs balance-relative are distinct policies -> distinct addresses"
        );

        OpenZapV2 zFixed = OpenZapV2(payable(factory.createZap(pFixed, bytes32("m"))));
        OpenZapV2 zRel = OpenZapV2(payable(factory.createZap(pRel, bytes32("m"))));
        assertTrue(zFixed.policyHash() != zRel.policyHash(), "distinct policy hashes");
    }

    /// Balance-relative never over-approves: the approval equals the actual balance, and a swap that
    /// consumes only part of it leaves no residual allowance.
    function test_balanceRelative_approvalBoundedByBalance() public {
        MockERC20 tA = _newToken("Ap");
        MockERC20 tB = _newToken("Bp");
        _fundAdapterReserve(tB, 1_000_000e18);

        Step[] memory steps = new Step[](1);
        steps[0] = _swapStep(address(tA), address(tB), BALANCE_RELATIVE, 1e18);
        address[] memory tracked = new address[](2);
        (tracked[0], tracked[1]) = (address(tA), address(tB));
        Policy memory p = Policy(owner, recipient, FEE_CAP, true, tracked, steps);

        OpenZapV2 z = OpenZapV2(payable(factory.createZap(p, bytes32("br-appr"))));
        tA.mint(address(z), 42e18); // arbitrary standing balance

        OpenZapIntent memory it = _intentFor(z, address(tB), 42e18, 0, address(0));
        z.execute(it, _signIntent(OWNER_PK, it));

        assertEq(tB.balanceOf(recipient), 42e18, "spent exactly the balance");
        assertEq(tA.allowance(address(z), address(adapter)), 0, "approval reset to zero");
    }

    function _buildAllRelativeChain(bytes32 salt) internal returns (OpenZapV2 z, MockERC20 tC) {
        MockERC20 tA = _newToken("Aa");
        MockERC20 tB = _newToken("Ba");
        tC = _newToken("Ca");
        _fundAdapterReserve(tB, 1_000_000e18);
        _fundAdapterReserve(tC, 1_000_000e18);

        Step[] memory steps = new Step[](2);
        steps[0] = _swapStep(address(tA), address(tB), BALANCE_RELATIVE, 1e18);
        steps[1] = _swapStep(address(tB), address(tC), BALANCE_RELATIVE, 1e18);

        address[] memory tracked = new address[](3);
        (tracked[0], tracked[1], tracked[2]) = (address(tA), address(tB), address(tC));
        Policy memory p = Policy(owner, recipient, FEE_CAP, true, tracked, steps);

        z = OpenZapV2(payable(factory.createZap(p, salt)));
        tA.mint(address(z), AMOUNT_IN); // 100 A -> 100 B -> 100 C
    }
}

// =========================================================================== //
// Stateful invariants — driven against a BALANCE-RELATIVE zap so the new path   //
// is exercised on every run.                                                    //
// =========================================================================== //

/// @dev Drives random sequences of execute / emergency-exit against one balance-relative zap.
contract V2Handler is Test {
    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "OpenZapIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address recipient,address relayer,uint256 maxRelayerFee,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    OpenZapV2 internal zap;
    MockERC20 internal tokenIn;
    MockERC20 internal tokenOut;
    address internal adapter;
    uint256 internal ownerPk;
    address internal owner;
    address internal recipient;
    address internal relayer;
    uint256 public nonce = 1;

    constructor(
        OpenZapV2 zap_,
        MockERC20 tokenIn_,
        MockERC20 tokenOut_,
        address adapter_,
        uint256 ownerPk_,
        address recipient_,
        address relayer_
    ) {
        zap = zap_;
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        adapter = adapter_;
        ownerPk = ownerPk_;
        owner = vm.addr(ownerPk_);
        recipient = recipient_;
        relayer = relayer_;
    }

    function doExecute(uint256 feeSeed, uint256 amtSeed) external {
        // Random top-up: the single step is balance-relative, so it will spend whatever is present.
        tokenIn.mint(address(zap), bound(amtSeed, 1, 500e18));
        OpenZapIntent memory it = OpenZapIntent({
            zap: address(zap),
            chainId: block.chainid,
            nonce: nonce++,
            validAfter: 0,
            deadline: type(uint64).max,
            recipient: recipient,
            relayer: relayer,
            maxRelayerFee: bound(feeSeed, 0, 5e18),
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: address(tokenOut),
            minOut: 0
        });
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("2"), block.chainid, address(zap)));
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        try zap.execute(it, abi.encodePacked(r, s, v)) {} catch {}
    }

    function doExit() external {
        address[] memory a = new address[](2);
        a[0] = address(tokenIn);
        a[1] = address(tokenOut);
        vm.prank(owner);
        try zap.emergencyExit(a) {} catch {}
    }
}

/// @notice Stateful invariants on the balance-relative path: no residual approval ever; the shared
///         implementation is never owned; and a balance-relative zap never strands its input token
///         between runs (each run consumes the whole balance).
contract V2Invariants is V2BaseTest {
    V2Handler internal handler;
    OpenZapV2 internal brZap;
    MockERC20 internal brIn;
    MockERC20 internal brOut;

    function setUp() public override {
        super.setUp();

        brIn = _newToken("BRIN");
        brOut = _newToken("BROUT");
        brOut.mint(address(adapter), 100_000_000e18);

        Step[] memory steps = new Step[](1);
        steps[0] = _swapStep(address(brIn), address(brOut), BALANCE_RELATIVE, 1e18);
        address[] memory tracked = new address[](2);
        (tracked[0], tracked[1]) = (address(brIn), address(brOut));
        Policy memory p = Policy(owner, recipient, FEE_CAP, true, tracked, steps);
        brZap = OpenZapV2(payable(factory.createZap(p, bytes32("inv-br"))));

        handler = new V2Handler(brZap, brIn, brOut, address(adapter), OWNER_PK, recipient, relayer);
        targetContract(address(handler));

        // Pin the senders (see v1 invariant suite for the fork-determinism rationale).
        targetSender(address(0xA11CE));
        targetSender(address(0xB0B));
        targetSender(address(0xCA11));
    }

    /// @dev I-APPR-1: between transactions, the zap never holds a live approval to the adapter.
    function invariant_noResidualApproval() public view {
        assertEq(brIn.allowance(address(brZap), address(adapter)), 0);
    }

    /// @dev The balance-relative zap never strands its input token: each successful run spends it all,
    ///      and a failed run reverts atomically. Either way, no input can accumulate across runs.
    function invariant_noStrandedInput() public view {
        assertEq(brIn.balanceOf(address(brZap)), 0);
    }

    /// @dev I-ISO-1: the shared implementation is never initialized, so it never has an owner.
    function invariant_implementationNeverOwned() public view {
        assertEq(OpenZapV2(payable(factory.implementation())).owner(), address(0));
    }
}
