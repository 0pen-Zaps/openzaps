// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {IOzSeedERC20, IOzSeedVault, OzUSDGAtomicSeeder} from "../src/operations/OzUSDGAtomicSeeder.sol";
import {SeedOzUSDGRobinhood} from "../script/SeedOzUSDGRobinhood.s.sol";

contract AtomicSeedForkOwnerCaller {
    function run(SeedOzUSDGRobinhood seed) external returns (SeedOzUSDGRobinhood.Result memory) {
        return seed.run();
    }
}

contract AtomicSeedForkScriptHarness is SeedOzUSDGRobinhood {
    function _startOwnerBroadcast() internal override {
        vm.startPrank(OWNER);
    }

    function _stopOwnerBroadcast() internal override {
        vm.stopPrank();
    }
}

/// @notice Opt-in, local-only rehearsal of the atomic helper path against the audited Robinhood
///         snapshot. Owner impersonation exists only inside the disposable fork.
contract SeedOzUSDGRobinhoodForkTest is Test {
    uint256 internal constant AUDITED_FORK_BLOCK = 22_303_042;

    address internal constant OWNER = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant OZ_USDG = 0xeAD10C998c59745a030FfAc9209b294C14C7D325;

    function testFork_rehearsesAtomicDeploymentApprovalsAndSeed() public {
        if (!vm.envOr("RUN_ROBINHOOD_OZUSDG_SEED_FORK", false)) {
            vm.skip(true);
            return;
        }

        uint256 forkBlock = vm.envOr("ROBINHOOD_OZUSDG_SEED_FORK_BLOCK", AUDITED_FORK_BLOCK);
        string memory rpcUrl = vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        vm.createSelectFork(rpcUrl, forkBlock);

        AtomicSeedForkScriptHarness script = new AtomicSeedForkScriptHarness();
        AtomicSeedForkOwnerCaller caller = new AtomicSeedForkOwnerCaller();
        vm.etch(OWNER, address(caller).code);

        SeedOzUSDGRobinhood.Result memory result = AtomicSeedForkOwnerCaller(OWNER).run(script);
        OzUSDGAtomicSeeder helper = result.helper;

        assertTrue(helper.seeded());
        assertEq(address(helper).codehash, keccak256(type(OzUSDGAtomicSeeder).runtimeCode));
        assertEq(result.quotedAeweth, 28_760_364_065_631);
        assertEq(result.quotedUsdG, 54_990);
        assertEq(result.minimumUsdG, 54_440);
        assertEq(result.atomic.measuredSwapOutput, 54_990);
        assertEq(result.atomic.seedShares, 1_000_000_000);
        assertEq(result.atomic.refundedUsdG, 1_450);

        assertEq(IOzSeedERC20(ZAPS).allowance(OWNER, address(helper)), 0);
        assertEq(IOzSeedERC20(USDG).allowance(OWNER, address(helper)), 0);
        assertEq(IOzSeedERC20(ZAPS).balanceOf(address(helper)), 0);
        assertEq(IOzSeedERC20(USDG).balanceOf(address(helper)), 0);
        assertEq(IOzSeedVault(OZ_USDG).totalAssets(), 1_000_000);
        assertEq(IOzSeedVault(OZ_USDG).totalSupply(), 1_000_000_000);
        assertEq(IOzSeedVault(OZ_USDG).balanceOf(DEAD), 1_000_000_000);
    }
}
