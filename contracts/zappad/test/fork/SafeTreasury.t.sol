// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { ISafe, ISafeProxyFactory } from "../../src/interfaces/ISafe.sol";
import { SafeTreasuryDeployment } from "../../script/lib/SafeTreasuryDeployment.sol";

/// @dev Deploys only inside a local fork; no transaction is broadcast.
///      ROBINHOOD_RPC_URL="https://..." forge test --match-contract SafeTreasuryForkTest -vv
contract SafeTreasuryForkTest is Test {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 internal constant DEFAULT_FORK_BLOCK = 21_955_368;

    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    bytes32 internal constant SAFE_PROXY_FACTORY_CODE_HASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    bytes32 internal constant SAFE_SINGLETON_CODE_HASH =
        0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4;
    address internal constant COMPATIBILITY_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    bytes32 internal constant COMPATIBILITY_FALLBACK_HANDLER_CODE_HASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;

    bytes32 internal constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
    bytes32 internal constant GUARD_STORAGE_SLOT =
        0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    address internal constant SENTINEL_MODULES = address(0x1);

    function test_liveCanonicalSafeTreasuryDeploymentReadbacks() public {
        if (!_selectRobinhoodFork()) return;

        assertEq(block.chainid, ROBINHOOD_CHAIN_ID);
        assertEq(SAFE_PROXY_FACTORY.codehash, SAFE_PROXY_FACTORY_CODE_HASH, "proxy factory");
        assertEq(SAFE_SINGLETON.codehash, SAFE_SINGLETON_CODE_HASH, "singleton");
        assertEq(
            COMPATIBILITY_FALLBACK_HANDLER.codehash,
            COMPATIBILITY_FALLBACK_HANDLER_CODE_HASH,
            "fallback handler"
        );

        address[] memory owners = new address[](3);
        owners[0] = makeAddr("safe-owner-one");
        owners[1] = makeAddr("safe-owner-two");
        owners[2] = makeAddr("safe-owner-three");
        uint256 threshold = 2;
        uint256 saltNonce = uint256(keccak256("ZapPad canonical Safe v1.4.1 fork test"));

        bytes memory setupData =
            SafeTreasuryDeployment.initializer(owners, threshold, COMPATIBILITY_FALLBACK_HANDLER);
        address predicted =
            SafeTreasuryDeployment.predict(SAFE_PROXY_FACTORY, SAFE_SINGLETON, setupData, saltNonce);
        assertEq(predicted.code.length, 0, "predicted proxy must be fresh");
        SafeTreasuryDeployment.requireFresh(predicted);

        address deployed =
            ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(SAFE_SINGLETON, setupData, saltNonce);
        assertEq(deployed, predicted, "CREATE2 prediction");

        SafeTreasuryDeployment.verify(
            deployed,
            predicted,
            SAFE_SINGLETON,
            COMPATIBILITY_FALLBACK_HANDLER,
            owners,
            threshold,
            ROBINHOOD_CHAIN_ID,
            true
        );

        ISafe safe = ISafe(deployed);
        assertEq(safe.masterCopy(), SAFE_SINGLETON, "master copy");
        assertEq(safe.VERSION(), "1.4.1", "version");
        assertEq(safe.getChainId(), ROBINHOOD_CHAIN_ID, "chain");
        assertEq(safe.getOwners(), owners, "owners");
        assertEq(safe.getThreshold(), 2, "2-of-3 threshold");
        assertEq(
            _storageAddress(safe, FALLBACK_HANDLER_STORAGE_SLOT),
            COMPATIBILITY_FALLBACK_HANDLER,
            "fallback handler"
        );
        assertEq(_storageAddress(safe, GUARD_STORAGE_SLOT), address(0), "zero guard");
        (address[] memory modules, address next) = safe.getModulesPaginated(SENTINEL_MODULES, 1);
        assertEq(modules.length, 0, "empty modules");
        assertEq(next, SENTINEL_MODULES, "module sentinel");
        assertEq(safe.nonce(), 0, "fresh nonce");

        vm.expectRevert(abi.encodeWithSelector(SafeTreasuryDeployment.ExistingProxy.selector, predicted));
        this.requireFresh(predicted);
    }

    function requireFresh(address predicted) external view {
        SafeTreasuryDeployment.requireFresh(predicted);
    }

    function _selectRobinhoodFork() private returns (bool selected) {
        string memory rpcUrl = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return false;
        }

        uint256 forkBlock = vm.envOr("ROBINHOOD_FORK_BLOCK", DEFAULT_FORK_BLOCK);
        if (forkBlock == 0) {
            vm.createSelectFork(rpcUrl);
        } else {
            vm.createSelectFork(rpcUrl, forkBlock);
        }
        return true;
    }

    function _storageAddress(ISafe safe, bytes32 slot) private view returns (address) {
        bytes memory value = safe.getStorageAt(uint256(slot), 1);
        assertEq(value.length, 32, "storage read length");
        return abi.decode(value, (address));
    }
}
