// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZapCreationGateway} from "../src/fee/OpenZapCreationGateway.sol";
import {ZapCreationFeePot} from "../src/fee/ZapCreationFeePot.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {Policy, Step} from "../src/libraries/OpenZapTypes.sol";

/// @notice Fork-only proof that the gateway can call all existing factories and the live adapter.
contract OpenZapCreationGatewayForkTest is Test {
    uint256 internal constant CREATION_FEE = 0.00001 ether;

    address internal constant GOVERNANCE = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address internal constant ONE_SHOT_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;
    address internal constant TRIGGER_FACTORY = 0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9;
    address internal constant RECURRING_FACTORY = 0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant CREATION_ADAPTER = 0x04f62dA4b51a010eFa32aa81569169C47AEd602C;

    function testFork_allLiveFactoriesAndAdapterCreateAndConvertAtomically() public {
        if (!vm.envOr("RUN_ROBINHOOD_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));
        ZapCreationFeePot pot = new ZapCreationFeePot(GOVERNANCE, ZAPS);
        OpenZapCreationGateway gateway = new OpenZapCreationGateway(
            ONE_SHOT_FACTORY, TRIGGER_FACTORY, RECURRING_FACTORY, AEWETH, ZAPS, CREATION_ADAPTER, pot, CREATION_FEE
        );
        vm.prank(GOVERNANCE);
        pot.setGateway(address(gateway));

        address player = address(0xA11CE);
        vm.deal(player, 1 ether);
        Policy memory p = _policy(player);
        address[3] memory factories = [ONE_SHOT_FACTORY, TRIGGER_FACTORY, RECURRING_FACTORY];
        for (uint256 i; i < 3; ++i) {
            OpenZapCreationGateway.Lineage lineage = OpenZapCreationGateway.Lineage(i);
            bytes32 salt = keccak256(abi.encode("gateway-live-fork", i));
            address predicted = gateway.predict(lineage, p, salt);

            vm.prank(player);
            address zap = gateway.createZap{value: CREATION_FEE}(lineage, p, salt, 1);

            assertEq(zap, predicted);
            assertGt(zap.code.length, 0);
            assertEq(OpenZap(payable(zap)).owner(), player);
            assertEq(OpenZap(payable(zap)).FACTORY(), factories[i]);
        }
        assertGt(pot.accountedZaps(), 0, "live adapter must produce 0xZAPS");
        assertEq(pot.accountedZaps(), pot.roundPrize(1));
        assertEq(pot.accountedZaps(), pot.tickets(1, player));
    }

    function _policy(address player) private pure returns (Policy memory p) {
        address[] memory tracked = new address[](2);
        tracked[0] = AEWETH;
        tracked[1] = ZAPS;
        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: CREATION_ADAPTER, tokenIn: AEWETH, spender: CREATION_ADAPTER, amountIn: 0.000001 ether, data: ""
        });
        p = Policy({
            owner: player,
            recipient: player,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
    }
}
