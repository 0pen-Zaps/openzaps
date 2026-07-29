// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {DeployRobinhoodTestnetSoak} from "../script/DeployRobinhoodTestnetSoak.s.sol";
import {Step} from "../src/libraries/OpenZapTypes.sol";
import {OpenZapV3} from "../src/v3/OpenZapV3.sol";
import {RecurringIntent} from "../src/v3/libraries/OpenZapV3Types.sol";
import {
    RobinhoodTestnetOnly,
    RobinhoodTestnetSoakToken,
    RobinhoodTestnetSoakPriceSource
} from "../src/testnet/RobinhoodTestnetSoakSupport.sol";

contract DeployRobinhoodTestnetSoakTest is Test {
    uint256 internal constant ROBINHOOD_TESTNET_CHAIN_ID = 46630;
    address internal constant EXECUTOR = address(0xE0EC);
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;

    address internal governance;
    bytes32 internal acceptedDigest;

    function setUp() public {
        vm.chainId(ROBINHOOD_TESTNET_CHAIN_ID);
        governance = address(this);
    }

    function testFuzz_runRefusesEveryNon46630Chain(uint64 wrongChain) public {
        vm.assume(uint256(wrongChain) != ROBINHOOD_TESTNET_CHAIN_ID);
        vm.chainId(uint256(wrongChain));

        DeployRobinhoodTestnetSoak deployment = new DeployRobinhoodTestnetSoak();
        vm.expectRevert(abi.encodeWithSelector(DeployRobinhoodTestnetSoak.WrongChain.selector, uint256(wrongChain)));
        deployment.run(governance);
    }

    function test_supportArtifactsAlsoRefuseNon46630Deployment() public {
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(RobinhoodTestnetOnly.WrongChain.selector, uint256(4663)));
        new RobinhoodTestnetSoakToken("not deployable", "NOPE", 18, governance, 1 ether);
    }

    function test_runDeploysFreshBoundedTestnetOnlyLineageAndAssertsPins() public {
        DeployRobinhoodTestnetSoak.Deployed memory d = _deploy();

        assertEq(d.adapters.owner(), governance);
        assertEq(d.adapters.pendingOwner(), address(0));
        assertEq(d.tokens.owner(), governance);
        assertEq(d.tokens.pendingOwner(), address(0));
        assertEq(d.priceSources.owner(), governance);
        assertEq(d.priceSources.pendingOwner(), address(0));
        assertEq(d.lotteryPot.owner(), governance);
        assertEq(d.lotteryPot.pendingOwner(), address(0));
        assertEq(d.priceSource.owner(), governance);

        assertTrue(address(d.adapters).code.length != 0);
        assertTrue(address(d.tokens).code.length != 0);
        assertTrue(address(d.priceSources).code.length != 0);
        assertTrue(address(d.inputToken).code.length != 0);
        assertTrue(address(d.outputToken).code.length != 0);
        assertTrue(address(d.adapter).code.length != 0);
        assertTrue(address(d.priceSource).code.length != 0);
        assertTrue(address(d.lotteryPot).code.length != 0);
        assertTrue(address(d.factory).code.length != 0);
        assertTrue(d.implementation.code.length != 0);
        assertTrue(d.soakZap.code.length != 0);

        assertEq(d.inputToken.name(), "Robinhood Testnet Soak Input (TEST ONLY)");
        assertEq(d.inputToken.symbol(), "rtSOAK-IN");
        assertEq(d.outputToken.name(), "Robinhood Testnet Soak ZAPS (TEST ONLY)");
        assertEq(d.outputToken.symbol(), "rtZAPS");
        assertEq(d.inputToken.totalSupply(), 24 ether);
        assertEq(d.inputToken.balanceOf(d.soakZap), 24 ether);
        assertEq(d.inputToken.balanceOf(governance), 0);
        assertEq(d.outputToken.totalSupply(), 48 ether);
        assertEq(d.outputToken.balanceOf(address(d.adapter)), 48 ether);
        assertEq(d.outputToken.balanceOf(governance), 0);

        assertEq(d.adapter.INPUT_TOKEN(), address(d.inputToken));
        assertEq(d.adapter.OUTPUT_TOKEN(), address(d.outputToken));
        assertEq(d.adapter.RATE_WAD(), 1e18);
        assertEq(d.priceSource.priceX96(), 1 << 96);
        assertTrue(d.adapters.isAllowed(address(d.adapter)));
        assertTrue(d.tokens.isAllowed(address(d.inputToken)));
        assertTrue(d.tokens.isAllowed(address(d.outputToken)));
        assertTrue(d.priceSources.isAllowed(address(d.priceSource)));

        assertEq(address(d.factory.adapters()), address(d.adapters));
        assertEq(address(d.factory.tokens()), address(d.tokens));
        assertEq(address(d.factory.priceSources()), address(d.priceSources));
        assertEq(address(d.factory.lotteryPot()), address(d.lotteryPot));
        assertEq(d.factory.implCodeHash(), d.implementation.codehash);
        assertEq(d.lotteryPot.ZAPS(), address(d.outputToken));
        assertEq(d.lotteryPot.BUY_ADAPTER(), address(d.adapter));
        assertEq(d.lotteryPot.factory(), address(d.factory));
        assertTrue(d.lotteryPot.isZap(d.soakZap));

        OpenZapV3 zap = OpenZapV3(payable(d.soakZap));
        assertEq(zap.owner(), governance);
        assertEq(zap.recipient(), governance);
        assertEq(zap.FACTORY(), address(d.factory));
        assertEq(address(zap.ADAPTERS()), address(d.adapters));
        assertEq(address(zap.TOKENS()), address(d.tokens));
        assertEq(address(zap.PRICE_SOURCES()), address(d.priceSources));
        assertEq(zap.LOTTERY_POT(), address(d.lotteryPot));
        assertEq(zap.policyHash(), d.policyHash);
        assertTrue(zap.optimization());
        assertFalse(zap.policyHalted());
        assertEq(zap.stepCount(), 1);

        Step memory step = zap.step(0);
        assertEq(step.adapter, address(d.adapter));
        assertEq(step.tokenIn, address(d.inputToken));
        assertEq(step.spender, address(d.adapter));
        assertEq(step.amountIn, 1 ether);
        assertEq(step.data.length, 0);
    }

    function test_deployedLineageExecutesOneBoundedRecurringRun() public {
        DeployRobinhoodTestnetSoak.Deployed memory d = _deploy();
        OpenZapV3 zap = OpenZapV3(payable(d.soakZap));

        RecurringIntent memory intent = RecurringIntent({
            zap: d.soakZap,
            chainId: ROBINHOOD_TESTNET_CHAIN_ID,
            seriesId: 1,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 25 hours),
            interval: 1 hours,
            maxRuns: 24,
            recipient: governance,
            executor: address(0),
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: d.policyHash,
            outAsset: address(d.outputToken),
            minOutPerRun: 0.99 ether
        });

        bytes32 digest = zap.hashRecurringIntent(intent);
        acceptedDigest = digest;
        bytes memory signature = new bytes(65);

        vm.prank(EXECUTOR);
        zap.executeRecurring(intent, signature);

        assertEq(d.inputToken.balanceOf(d.soakZap), 23 ether, "one of 24 funded runs consumed");
        assertEq(d.inputToken.balanceOf(address(d.adapter)), 1 ether, "adapter received fixed input");
        assertEq(d.outputToken.balanceOf(governance), 0.99 ether, "recipient received net output");
        assertEq(d.outputToken.balanceOf(EXECUTOR), 0.008 ether, "executor received 80% of fee");
        assertEq(d.outputToken.balanceOf(address(d.lotteryPot)), 0.002 ether, "pot received 20% of fee");
        assertEq(d.lotteryPot.roundPrize(1), 0.002 ether);
        assertEq(d.lotteryPot.tickets(1, governance), 0.002 ether);

        (uint32 runs, uint64 lastRun) = zap.series(intent.seriesId);
        assertEq(runs, 1);
        assertEq(lastRun, uint64(block.timestamp));
        assertFalse(zap.nonceUsed(intent.seriesId), "23 authorized runs remain");
    }

    function test_syntheticPriceSourceFailsClosedDuringOutageInjection() public {
        DeployRobinhoodTestnetSoak.Deployed memory d = _deploy();

        d.priceSource.setPriceX96(0);

        vm.expectRevert(RobinhoodTestnetSoakPriceSource.PriceUnavailable.selector);
        d.priceSource.priceX96();
    }

    function _deploy() internal returns (DeployRobinhoodTestnetSoak.Deployed memory d) {
        DeployRobinhoodTestnetSoak deployment = new DeployRobinhoodTestnetSoak();
        d = deployment.run(governance);
    }

    /// @dev Keyless ERC-1271 fixture: the test records the one digest it intends to authorize.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (digest == acceptedDigest && signature.length == 65) return ERC1271_MAGIC;
        return 0xffffffff;
    }
}
