// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {DeployV1_2Robinhood} from "../script/DeployV1_2Robinhood.s.sol";
import {ZapCreationFeePot} from "../src/fee/ZapCreationFeePot.sol";
import {Policy, Step} from "../src/libraries/OpenZapTypes.sol";

interface IERC20V1_2Fork {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract DeployV1_2RobinhoodForkCaller {
    function run(DeployV1_2Robinhood deployment) external returns (DeployV1_2Robinhood.Deployed memory) {
        return deployment.run();
    }
}

/// @notice Opt-in proof that the guarded script and dedicated gateway work against one explicitly
///         pinned live snapshot: governance, allowlists, v1.1 continuity, and the canonical
///         aeWETH -> 0xZAPS fee route.
contract DeployV1_2RobinhoodForkTest is Test {
    uint256 internal constant CREATION_FEE = 0.00001 ether;

    address internal constant GOVERNANCE = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant CREATION_ADAPTER = 0x04f62dA4b51a010eFa32aa81569169C47AEd602C;
    ZapCreationFeePot internal constant LEGACY_CREATION_POT =
        ZapCreationFeePot(0x8E0399A8fF81a5f73Bc76CAEE8a355cF9bb0d863);

    function testFork_deploysAndCreatesV1_2WithoutTouchingLegacyPrizeRound() public {
        if (!vm.envOr("RUN_ROBINHOOD_FORK", false)) {
            vm.skip(true);
            return;
        }
        uint256 forkBlock = vm.envUint("ROBINHOOD_FORK_BLOCK");
        vm.createSelectFork(vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")), forkBlock);

        uint256 legacyRoundBefore = LEGACY_CREATION_POT.currentRound();
        uint256 legacyAccountedBefore = LEGACY_CREATION_POT.accountedZaps();
        uint256 legacyBalanceBefore = IERC20V1_2Fork(ZAPS).balanceOf(address(LEGACY_CREATION_POT));

        DeployV1_2Robinhood deployment = new DeployV1_2Robinhood();
        DeployV1_2RobinhoodForkCaller caller = new DeployV1_2RobinhoodForkCaller();
        vm.etch(GOVERNANCE, address(caller).code);
        DeployV1_2Robinhood.Deployed memory d = DeployV1_2RobinhoodForkCaller(GOVERNANCE).run(deployment);

        address player = address(0xA11CE);
        vm.deal(player, 1 ether);
        Policy memory p = _policy(player);
        bytes32 salt = keccak256("v1.2-live-fork");
        address predicted = d.creationGateway.predict(p, salt);

        vm.prank(player);
        address zapAddress = d.creationGateway.createZap{value: CREATION_FEE}(p, salt, 1);
        OpenZap zap = OpenZap(payable(zapAddress));

        assertEq(zapAddress, predicted);
        assertGt(zapAddress.code.length, 0);
        assertEq(zap.FACTORY(), address(d.factory));
        assertEq(zap.owner(), player);
        assertFalse(zap.policyHalted());

        uint256 credited = d.creationPot.tickets(1, player);
        assertGt(credited, 0, "live creation route must produce 0xZAPS");
        assertEq(d.creationPot.accountedZaps(), credited);
        assertEq(d.creationPot.roundPrize(1), credited);
        assertEq(IERC20V1_2Fork(ZAPS).balanceOf(address(d.creationPot)), credited);

        assertEq(address(d.creationGateway).balance, 0);
        assertEq(IERC20V1_2Fork(AEWETH).balanceOf(address(d.creationGateway)), 0);
        assertEq(IERC20V1_2Fork(ZAPS).balanceOf(address(d.creationGateway)), 0);
        assertEq(IERC20V1_2Fork(AEWETH).allowance(address(d.creationGateway), CREATION_ADAPTER), 0);

        assertEq(LEGACY_CREATION_POT.currentRound(), legacyRoundBefore);
        assertEq(LEGACY_CREATION_POT.accountedZaps(), legacyAccountedBefore);
        assertEq(IERC20V1_2Fork(ZAPS).balanceOf(address(LEGACY_CREATION_POT)), legacyBalanceBefore);
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
