// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZapV3} from "../src/v3/OpenZapV3.sol";
import {OpenZapFactoryV3} from "../src/v3/OpenZapFactoryV3.sol";
import {ZapLotteryPot} from "../src/v3/ZapLotteryPot.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {Step, Policy} from "../src/libraries/OpenZapTypes.sol";
import {RecurringIntent, TriggerIntent} from "../src/v3/libraries/OpenZapV3Types.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {MockZapsBuyAdapter} from "./mocks/MockZapsBuyAdapter.sol";
import {MockPriceSource} from "./mocks/MockPriceSource.sol";

/// @dev Shared v3 fixture: governance + pot + factory + a funded 1-step swap zap whose OUT asset is
///      the pot's prize asset (so recurring/trigger pot fees credit the prize directly), plus
///      independent EIP-712 signing helpers for both new intent kinds (domain version "3").
abstract contract BaseV3Test is Test {
    bytes32 internal constant RECURRING_TYPEHASH = keccak256(
        "RecurringIntent(address zap,uint256 chainId,uint256 seriesId,uint64 validAfter,uint64 deadline,uint64 interval,uint32 maxRuns,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOutPerRun)"
    );
    bytes32 internal constant TRIGGER_TYPEHASH = keccak256(
        "TriggerIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address priceSource,uint256 baselinePriceX96,uint32 thresholdBps,bool above,address recipient,address executor,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;
    address internal recipient = address(0xBEEF);
    address internal executor = address(0xE44C);
    address internal potGov = address(0x60D5);

    AdapterRegistry internal registry;
    AdapterRegistry internal priceSources;
    TokenAllowlist internal allowlist;
    ZapLotteryPot internal pot;
    OpenZapFactoryV3 internal factory;
    MockERC20 internal tokenIn;
    MockERC20 internal tokenOut; // doubles as the pot's prize asset ("0xZAPS") in these suites
    MockSwapAdapter internal adapter;
    MockZapsBuyAdapter internal buyAdapter;
    MockPriceSource internal priceSource;
    OpenZapV3 internal zap;

    uint256 internal constant AMOUNT_IN = 100e18;
    uint256 internal constant OUT_PER_RUN = 100e18; // 1:1 mock rate
    uint256 internal constant RUN_FEE = 1e18; // 1% of 100e18
    uint256 internal constant EXECUTOR_CUT = 0.8e18; // 80% of the fee
    uint256 internal constant POT_CUT = 0.2e18; // 20% of the fee
    uint256 internal constant NET_PER_RUN = 99e18;
    uint32 internal constant MAX_RUNS = 3;
    uint64 internal constant INTERVAL = 1 hours;

    function setUp() public virtual {
        // Same ambient-fork re-pin as Base.t.sol so `--fork-url` runs stay deterministic.
        if (block.chainid == 8453) {
            vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")), 48_900_000);
        }

        owner = vm.addr(OWNER_PK);

        registry = new AdapterRegistry(address(this));
        priceSources = new AdapterRegistry(address(this));
        allowlist = new TokenAllowlist(address(this));

        tokenIn = new MockERC20("In", "IN", 18);
        tokenOut = new MockERC20("Zaps", "ZAPS", 18);
        allowlist.setToken(address(tokenIn), true);
        allowlist.setToken(address(tokenOut), true);

        adapter = new MockSwapAdapter();
        registry.setAdapter(address(adapter), true);
        tokenOut.mint(address(adapter), 1_000_000e18);

        buyAdapter = new MockZapsBuyAdapter(address(tokenOut), 1e18);
        tokenOut.mint(address(buyAdapter), 1_000_000e18);

        priceSource = new MockPriceSource();
        priceSources.setAdapter(address(priceSource), true);

        pot = new ZapLotteryPot(potGov, address(tokenOut), address(buyAdapter));
        factory = new OpenZapFactoryV3(registry, allowlist, priceSources, pot);
        vm.prank(potGov);
        pot.setFactory(address(factory));

        zap = OpenZapV3(payable(factory.createZap(_defaultPolicy(), bytes32("zap-v3-1"))));
        tokenIn.mint(address(zap), AMOUNT_IN * MAX_RUNS); // enough for a full series
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
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
    }

    function _defaultRecurring() internal view returns (RecurringIntent memory it) {
        it = RecurringIntent({
            zap: address(zap),
            chainId: block.chainid,
            seriesId: 11,
            validAfter: 0,
            deadline: uint64(block.timestamp + 30 days),
            interval: INTERVAL,
            maxRuns: MAX_RUNS,
            recipient: recipient,
            executor: address(0),
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: address(tokenOut),
            minOutPerRun: 98e18
        });
    }

    function _defaultTrigger() internal view returns (TriggerIntent memory it) {
        it = TriggerIntent({
            zap: address(zap),
            chainId: block.chainid,
            nonce: 21,
            validAfter: 0,
            deadline: uint64(block.timestamp + 30 days),
            priceSource: address(priceSource),
            baselinePriceX96: 1000e18,
            thresholdBps: 1000, // +/-10%
            above: true,
            recipient: recipient,
            executor: address(0),
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: address(tokenOut),
            minOut: 98e18
        });
    }

    // ---- independent EIP-712 digests (domain version "3") ----

    function _domain(address verifyingZap) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("3"), block.chainid, verifyingZap));
    }

    function _digestRecurring(RecurringIntent memory it) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                RECURRING_TYPEHASH,
                it.zap,
                it.chainId,
                it.seriesId,
                it.validAfter,
                it.deadline,
                it.interval,
                it.maxRuns,
                it.recipient,
                it.executor,
                it.maxGas,
                it.maxFeePerGas,
                it.policyHash,
                it.outAsset,
                it.minOutPerRun
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domain(it.zap), structHash));
    }

    function _digestTrigger(TriggerIntent memory it) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRIGGER_TYPEHASH,
                it.zap,
                it.chainId,
                it.nonce,
                it.validAfter,
                it.deadline,
                it.priceSource,
                it.baselinePriceX96,
                it.thresholdBps,
                it.above,
                it.recipient,
                it.executor,
                it.maxGas,
                it.maxFeePerGas,
                it.policyHash,
                it.outAsset,
                it.minOut
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domain(it.zap), structHash));
    }

    function _signRecurring(uint256 pk, RecurringIntent memory it) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digestRecurring(it));
        return abi.encodePacked(r, s, v);
    }

    function _signTrigger(uint256 pk, TriggerIntent memory it) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digestTrigger(it));
        return abi.encodePacked(r, s, v);
    }
}
