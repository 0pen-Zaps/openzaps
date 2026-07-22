// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {OpenZapIntent, Policy, Step} from "../src/libraries/OpenZapTypes.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @title DeployedBaseE2E
/// @notice Drives the contracts that `script/DeployBase.s.sol` actually broadcast, rather than
///         contracts this test deployed itself.
/// @dev This is the difference between "the script simulates" and "the deployed set works". It runs
///      against a node that already holds the broadcast — a local anvil fork of Base — and is
///      skipped everywhere else, because the addresses below only exist on that node.
///
///      What it proves is the thing the whole adapter effort exists for: a capsule executing a
///      TWO-step, TWO-protocol chain. Step 1 swaps USDC to WETH through Uniswap v3. Step 2 supplies
///      that WETH to Aave. Settlement measures the aToken. Before this, one swap was the ceiling.
contract DeployedBaseE2E is Test {
    // Set by DEPLOYED_* env vars so the test never hardcodes an address it did not deploy.
    address internal registry;
    address internal allowlist;
    address internal factoryAddr;
    address internal swapAdapter;
    address internal supplyAdapter;

    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant aWETH = 0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7;

    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;

    function setUp() public {
        // Only meaningful against the node that holds the broadcast.
        if (block.chainid != 8453) vm.skip(true);
        factoryAddr = vm.envOr("DEPLOYED_FACTORY", address(0));
        if (factoryAddr == address(0) || factoryAddr.code.length == 0) vm.skip(true);

        registry = vm.envOr("DEPLOYED_REGISTRY", address(0));
        allowlist = vm.envOr("DEPLOYED_ALLOWLIST", address(0));
        swapAdapter = vm.envOr("DEPLOYED_SWAP", address(0));
        supplyAdapter = vm.envOr("DEPLOYED_SUPPLY", address(0));
        owner = vm.addr(OWNER_PK);
    }

    function test_deployedSet_runsATwoProtocolChain() public {
        OpenZapFactory factory = OpenZapFactory(factoryAddr);
        assertEq(factory.VERSION(), "1.1.0", "deployed core is not v1.1");

        uint256 amountIn = 2_000e6; // 2,000 USDC

        Step[] memory steps = new Step[](2);
        // 1. Uniswap v3: USDC -> WETH. `data` is the adapter's 32-byte min-out and nothing else.
        steps[0] = Step({
            adapter: swapAdapter,
            tokenIn: USDC,
            spender: swapAdapter,
            amountIn: amountIn,
            data: abi.encode(uint256(0.2 ether))
        });
        // 2. Aave: WETH -> aWETH. This adapter takes no data at all.
        steps[1] = Step({
            adapter: supplyAdapter,
            tokenIn: WETH,
            spender: supplyAdapter,
            amountIn: 0.2 ether,
            data: ""
        });

        address[] memory tracked = new address[](3);
        tracked[0] = USDC;
        tracked[1] = WETH;
        tracked[2] = aWETH;

        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });

        address zapAddress = factory.createZap(policy, keccak256("deployed-e2e-uniswap-then-aave"));
        OpenZap zap = OpenZap(payable(zapAddress));

        deal(USDC, zapAddress, amountIn);

        uint256 ownerAWethBefore = IERC20(aWETH).balanceOf(owner);
        assertEq(IERC20(USDC).balanceOf(zapAddress), amountIn, "capsule not funded");

        OpenZapIntent memory intent = OpenZapIntent({
            zap: zapAddress,
            chainId: block.chainid,
            nonce: 0,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 10 minutes),
            recipient: owner,
            relayer: address(0),
            maxRelayerFee: 0,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: aWETH,
            minOut: 0.19 ether
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, zap.hashIntent(intent));

        zap.execute(intent, abi.encodePacked(r, s, v));

        uint256 gained = IERC20(aWETH).balanceOf(owner) - ownerAWethBefore;
        assertGe(gained, 0.19 ether, "recipient did not receive the aToken");

        // The swap's whole input is consumed, so nothing of the entry asset is left behind.
        assertEq(IERC20(USDC).balanceOf(zapAddress), 0, "USDC stranded in capsule");
        // No residual allowance survives either step.
        assertEq(IERC20(USDC).allowance(zapAddress, swapAdapter), 0, "residual USDC allowance");
        assertEq(IERC20(WETH).allowance(zapAddress, supplyAdapter), 0, "residual WETH allowance");

        // THE CONSTRAINT THIS TEST EXISTS TO PIN DOWN.
        //
        // `Step.amountIn` is a constant frozen into the policy at creation, so step 2 supplies the
        // 0.2 WETH the policy names — not the ~1.05 WETH step 1 actually produced. A step cannot
        // consume "whatever the previous step yielded", because that quantity is not known when the
        // owner signs. The surplus is not lost, but it does not flow: it sits in the capsule until
        // the owner sweeps it.
        //
        // This is what "multi-step" really means here, and the builder must not imply otherwise. A
        // design that swaps and then supplies the proceeds needs either an amount the author is
        // willing to fix in advance, or a v2 core with proportional/balance-relative step inputs.
        uint256 surplus = IERC20(WETH).balanceOf(zapAddress);
        assertGt(surplus, 0, "expected the unconsumed swap output to remain in the capsule");

        // Stranded is not stuck: the owner's unconditional exit recovers it.
        uint256 ownerWethBefore = IERC20(WETH).balanceOf(owner);
        address[] memory sweep = new address[](1);
        sweep[0] = WETH;
        vm.prank(owner);
        zap.emergencyExit(sweep);
        assertEq(IERC20(WETH).balanceOf(zapAddress), 0, "exit did not sweep the surplus");
        assertEq(IERC20(WETH).balanceOf(owner) - ownerWethBefore, surplus, "owner did not receive the surplus");

        console2.log("capsule           ", zapAddress);
        console2.log("USDC in           ", amountIn);
        console2.log("aWETH to recipient", gained);
        console2.log("WETH surplus swept", surplus);
    }
}
