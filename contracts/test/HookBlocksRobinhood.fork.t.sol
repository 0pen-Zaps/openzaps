// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {HookBlocks} from "../src/campaign/HookBlocks.sol";

interface IERC20Live {
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IWethLive is IERC20Live {
    function deposit() external payable;
}

interface IVaultLive is IERC20Live {
    function harvest() external;
    function claimable(address account, address rewardAsset) external view returns (uint256);
}

/// @dev Opt-in fork test against the LIVE Robinhood Chain state: the real fee
///      vault, the real HOOKR token, and the real native-ETH/HOOKR pool on
///      the canonical v4 PoolManager. Proves the campaign-2 buy-and-burn leg
///      end to end: fund 50 real shares -> harvest real Clanker fees ->
///      market-buy real HOOKR through the real pool -> burn it to the dead
///      address -> finalize the shares back to the sponsor.
///      Run with RUN_ROBINHOOD_FORK=true forge test --match-contract
///      HookBlocksRobinhoodForkTest -vv.
contract HookBlocksRobinhoodForkTest is Test {
    address internal constant VAULT = 0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant SPONSOR = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;
    bytes32 internal constant POOL_ID = 0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf;
    uint24 internal constant FEE = 2500;
    int24 internal constant SPACING = 25;

    function test_liveBuyAndBurnLegEndToEnd() public {
        // Report a SKIP, never a PASS: an opt-in test that returns early looks
        // identical to one that ran, which is how a suite goes green on
        // coverage it never had.
        if (!vm.envOr("RUN_ROBINHOOD_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));

        uint64 startAt = uint64(block.timestamp + 1 days);
        uint64 endAt = startAt + 14 days;
        uint64 sweepAfter = endAt + 30 days;

        HookBlocks hb = new HookBlocks(
            VAULT,
            WETH,
            HOOKR,
            POOL_MANAGER,
            FEE,
            SPACING,
            POOL_ID,
            SPONSOR,
            startAt,
            endAt,
            sweepAfter,
            9_700,
            0.05 ether,
            0.0005 ether
        );
        // The constructor already proved the pool key hashes to the live
        // poolId and that the live pool is initialized.
        assertEq(hb.POOL_ID(), POOL_ID);

        // The sponsor really holds all 100 shares after campaign 1 finalized.
        assertEq(IERC20Live(VAULT).balanceOf(SPONSOR), 100e18);
        vm.startPrank(SPONSOR);
        IERC20Live(VAULT).approve(address(hb), 50e18);
        hb.fundFeeShares(50e18);
        vm.stopPrank();
        assertEq(IERC20Live(VAULT).balanceOf(address(hb)), 50e18);

        // Pull whatever the live Clanker locker has pending so the shares
        // accrue real WETH; top up from a funded account so the buy clears
        // MIN_BUY_WEI regardless of the accrual level at fork time.
        IVaultLive(VAULT).harvest();
        address whale = makeAddr("fork-weth-source");
        vm.deal(whale, 1 ether);
        vm.startPrank(whale);
        IWethLive(WETH).deposit{value: 0.02 ether}();
        IERC20Live(WETH).transfer(address(hb), 0.02 ether);
        vm.stopPrank();

        assertEq(IERC20Live(HOOKR).balanceOf(address(hb)), 0);
        uint256 deadBefore = IERC20Live(HOOKR).balanceOf(hb.DEAD());

        // The real swap: unwrap aeWETH, buy HOOKR on the live pool, and burn
        // it to the dead address inside the same transaction.
        uint256 burned = hb.buyAndBurn(0);
        assertGt(burned, 0);
        assertEq(IERC20Live(HOOKR).balanceOf(hb.DEAD()) - deadBefore, burned);
        assertEq(IERC20Live(HOOKR).balanceOf(address(hb)), 0);
        assertEq(hb.totalHookrBurned(), burned);
        assertEq(hb.blockCount(), 1);
        HookBlocks.HookBlock memory blk = hb.hookBlock(0);
        assertGt(blk.ethIn, 0);
        assertLe(blk.ethIn, 0.05 ether);
        assertEq(blk.hookrBought, burned);

        // A second crank in the same block is refused.
        vm.expectRevert(HookBlocks.BuybackRateLimited.selector);
        hb.buyAndBurn(0);

        // Keep cranking on later blocks until the reward is fully converted.
        uint256 rounds;
        while (rounds < 10) {
            vm.roll(block.number + 1);
            (bool ok,) = address(hb).call(abi.encodeWithSelector(HookBlocks.buyAndBurn.selector, uint256(0)));
            if (!ok) break;
            rounds++;
        }
        assertLt(IERC20Live(WETH).balanceOf(address(hb)), 0.0005 ether);

        // Term ends: the shares go home; the burned HOOKR is already gone.
        vm.warp(endAt + 1);
        uint256 burnedAtFinalize = IERC20Live(HOOKR).balanceOf(hb.DEAD()) - deadBefore;
        hb.finalize();
        assertEq(IERC20Live(VAULT).balanceOf(SPONSOR), 100e18);
        assertEq(IERC20Live(VAULT).balanceOf(address(hb)), 0);
        assertEq(IERC20Live(HOOKR).balanceOf(hb.DEAD()) - deadBefore, burnedAtFinalize);
        assertEq(hb.totalHookrBurned(), burnedAtFinalize);
        assertEq(IERC20Live(HOOKR).balanceOf(address(hb)), 0);
    }
}
