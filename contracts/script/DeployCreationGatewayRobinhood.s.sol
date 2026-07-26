// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {OpenZapCreationGateway} from "../src/fee/OpenZapCreationGateway.sol";
import {ZapCreationFeePot} from "../src/fee/ZapCreationFeePot.sol";

/// @title DeployCreationGatewayRobinhood
/// @notice Deploys only the universal creation-fee gateway and its no-drain 0xZAPS pot on canonical
///         Robinhood Chain (4663). It reuses, and does not replace, the live v1.1/v3/v3.1 factories.
///
///         forge script script/DeployCreationGatewayRobinhood.s.sol --rpc-url $ROBINHOOD_RPC_URL \
///           --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract DeployCreationGatewayRobinhood is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 internal constant CREATION_FEE = 0.00001 ether;

    address internal constant EXPECTED_GOVERNANCE = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address internal constant ONE_SHOT_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;
    address internal constant TRIGGER_FACTORY = 0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9;
    address internal constant RECURRING_FACTORY = 0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant CREATION_ADAPTER = 0x04f62dA4b51a010eFa32aa81569169C47AEd602C;

    function run() external returns (ZapCreationFeePot pot, OpenZapCreationGateway gateway) {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "wrong chain");

        vm.startBroadcast();
        address governance = msg.sender;
        require(governance == EXPECTED_GOVERNANCE, "wrong governance signer");

        pot = new ZapCreationFeePot(governance, ZAPS);
        gateway = new OpenZapCreationGateway(
            ONE_SHOT_FACTORY, TRIGGER_FACTORY, RECURRING_FACTORY, AEWETH, ZAPS, CREATION_ADAPTER, pot, CREATION_FEE
        );
        pot.setGateway(address(gateway));
        vm.stopBroadcast();

        require(pot.gateway() == address(gateway), "gateway not bound");
        require(gateway.ONE_SHOT_FACTORY() == ONE_SHOT_FACTORY, "one-shot mismatch");
        require(gateway.TRIGGER_FACTORY() == TRIGGER_FACTORY, "trigger mismatch");
        require(gateway.RECURRING_FACTORY() == RECURRING_FACTORY, "recurring mismatch");
        require(gateway.CREATION_FEE() == CREATION_FEE, "fee mismatch");

        console2.log("governance       ", governance);
        console2.log("creationFeePot   ", address(pot));
        console2.log("creationGateway  ", address(gateway));
        console2.log("creationFee      ", CREATION_FEE);
    }
}
