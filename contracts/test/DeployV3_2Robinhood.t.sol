// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {DeployV3_2Robinhood} from "../script/DeployV3_2Robinhood.s.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {RobinhoodV4SwapAdapter} from "../src/adapters/RobinhoodV4SwapAdapter.sol";

contract DeployV3_2RobinhoodTest is Test {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    address internal constant GOVERNANCE = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address internal constant OTHER = address(0xBEEF);

    AdapterRegistry internal constant LIVE_ADAPTERS = AdapterRegistry(0x9E56e444f490C00A6277326A47Cb462E12dF1f17);
    TokenAllowlist internal constant LIVE_TOKENS = TokenAllowlist(0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B);
    RobinhoodV4SwapAdapter internal constant LIVE_SWAP_ADAPTER =
        RobinhoodV4SwapAdapter(0x04f62dA4b51a010eFa32aa81569169C47AEd602C);
    address internal constant LIVE_ONE_SHOT_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;
    address internal constant LIVE_TRIGGER_FACTORY = 0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9;
    address internal constant LIVE_RECURRING_FACTORY = 0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1;

    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 internal constant POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;

    DeployV3_2Robinhood internal deployment;

    function setUp() public {
        vm.chainId(ROBINHOOD_CHAIN_ID);
        deployment = new DeployV3_2Robinhood();

        vm.etch(address(LIVE_ADAPTERS), hex"00");
        vm.etch(address(LIVE_TOKENS), hex"00");
        vm.etch(address(LIVE_SWAP_ADAPTER), hex"00");
        vm.etch(LIVE_ONE_SHOT_FACTORY, hex"00");
        vm.etch(LIVE_TRIGGER_FACTORY, hex"00");
        vm.etch(LIVE_RECURRING_FACTORY, hex"00");
        vm.etch(POOL_MANAGER, hex"00");
        vm.etch(AEWETH, hex"00");
        vm.etch(ZAPS, hex"00");
    }

    function test_preflightRejectsWrongAdapterRegistryOwner() public {
        _mockLiveState(OTHER, address(0), GOVERNANCE, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(DeployV3_2Robinhood.LiveAdapterRegistryOwnerMismatch.selector, OTHER, GOVERNANCE)
        );
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function test_preflightRejectsPendingAdapterRegistryOwnershipTransfer() public {
        _mockLiveState(GOVERNANCE, OTHER, GOVERNANCE, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(DeployV3_2Robinhood.LiveAdapterRegistryOwnershipTransferPending.selector, OTHER)
        );
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function test_preflightRejectsWrongTokenAllowlistOwner() public {
        _mockLiveState(GOVERNANCE, address(0), OTHER, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(DeployV3_2Robinhood.LiveTokenAllowlistOwnerMismatch.selector, OTHER, GOVERNANCE)
        );
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function test_preflightRejectsPendingTokenAllowlistOwnershipTransfer() public {
        _mockLiveState(GOVERNANCE, address(0), GOVERNANCE, OTHER);

        vm.expectRevert(
            abi.encodeWithSelector(DeployV3_2Robinhood.LiveTokenAllowlistOwnershipTransferPending.selector, OTHER)
        );
        vm.prank(GOVERNANCE);
        deployment.run();
    }

    function _mockLiveState(
        address adapterRegistryOwner,
        address adapterRegistryPendingOwner,
        address tokenAllowlistOwner,
        address tokenAllowlistPendingOwner
    ) internal {
        vm.mockCall(address(LIVE_ADAPTERS), abi.encodeCall(LIVE_ADAPTERS.owner, ()), abi.encode(adapterRegistryOwner));
        vm.mockCall(
            address(LIVE_ADAPTERS),
            abi.encodeCall(LIVE_ADAPTERS.pendingOwner, ()),
            abi.encode(adapterRegistryPendingOwner)
        );
        vm.mockCall(address(LIVE_TOKENS), abi.encodeCall(LIVE_TOKENS.owner, ()), abi.encode(tokenAllowlistOwner));
        vm.mockCall(
            address(LIVE_TOKENS), abi.encodeCall(LIVE_TOKENS.pendingOwner, ()), abi.encode(tokenAllowlistPendingOwner)
        );
        vm.mockCall(
            address(LIVE_ADAPTERS),
            abi.encodeCall(LIVE_ADAPTERS.isAllowed, (address(LIVE_SWAP_ADAPTER))),
            abi.encode(true)
        );
        vm.mockCall(address(LIVE_SWAP_ADAPTER), abi.encodeCall(LIVE_SWAP_ADAPTER.currency0, ()), abi.encode(AEWETH));
        vm.mockCall(address(LIVE_SWAP_ADAPTER), abi.encodeCall(LIVE_SWAP_ADAPTER.currency1, ()), abi.encode(ZAPS));
        vm.mockCall(address(LIVE_SWAP_ADAPTER), abi.encodeCall(LIVE_SWAP_ADAPTER.poolId, ()), abi.encode(POOL_ID));
        vm.mockCall(address(LIVE_TOKENS), abi.encodeCall(LIVE_TOKENS.isAllowed, (AEWETH)), abi.encode(true));
        vm.mockCall(address(LIVE_TOKENS), abi.encodeCall(LIVE_TOKENS.isAllowed, (ZAPS)), abi.encode(true));
    }
}
