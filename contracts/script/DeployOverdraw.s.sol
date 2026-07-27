// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ZapOverdraw} from "../src/game/ZapOverdraw.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @title DeployOverdraw
/// @notice Deploys ONE `ZapOverdraw` table staked in 0xZAPS on Robinhood Chain (4663).
///
///         This script touches nothing else. OVERDRAW is a standalone game: it is not an adapter,
///         it is not allowlisted anywhere, it holds no policy capsule, and no OpenZap route can
///         reach it. Deploying it cannot affect the protocol contracts, and a bug in it cannot
///         reach a capsule's funds.
///
/// @dev WHAT DEPLOYING THIS MEANS. The contract has no admin, no pause and no upgrade path, so
///      every parameter below is decided once, here, forever. There is no second chance to fix a
///      wrong entry fee or a wrong rake recipient — the only remedy is to deploy a new table and
///      stop pointing the app at the old one, which strands nothing but does split the carry.
///
///      Read `src/game/ZapOverdraw.sol` in full before running this. In particular:
///        * the entry fee is the game's ENTIRE anti-sybil budget, so setting it low makes it cheap
///          for one player to occupy many of the 64 seats;
///        * the windows must be long enough that an honest player can actually come back and
///          reveal, because an unrevealed seat forfeits its entry by design; and
///        * `RAKE_RECIPIENT` is immutable and receives real tokens every round.
///
///      SETTING `NEXT_PUBLIC_OVERDRAW_ADDRESS` IN VERCEL IS A SEPARATE, LATER STEP. The web surface
///      fails closed to "not deployed" until that variable is set, and setting it is the moment the
///      product starts asking real people for real 0xZAPS. Do it only after verifying the deployed
///      bytecode, reading back every immutable below, and playing one round end to end.
///
///      Usage:
///        forge script script/DeployOverdraw.s.sol \
///          --rpc-url $ROBINHOOD_RPC --broadcast --verify
contract DeployOverdraw is Script {
    /// @dev 0xZAPS on Robinhood Chain (4663). Verify this against the live token before broadcast.
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;

    function run() external {
        address stake = vm.envOr("OVERDRAW_STAKE", ZAPS);
        address rakeRecipient = vm.envAddress("OVERDRAW_RAKE_RECIPIENT");
        uint256 entryFee = vm.envOr("OVERDRAW_ENTRY_FEE", uint256(1_000_000e18));
        uint64 commitWindow = uint64(vm.envOr("OVERDRAW_COMMIT_WINDOW", uint256(6 hours)));
        uint64 revealWindow = uint64(vm.envOr("OVERDRAW_REVEAL_WINDOW", uint256(6 hours)));
        uint16 rakeBps = uint16(vm.envOr("OVERDRAW_RAKE_BPS", uint256(200)));
        uint16 keeperBps = uint16(vm.envOr("OVERDRAW_KEEPER_BPS", uint256(50)));

        // Fail before broadcast rather than after: a table staked in a contract that is not an
        // ERC-20 would deploy happily and then revert on every single commit, and the immutable
        // stake address means that table could never be repaired.
        require(stake.code.length != 0, "stake is not a contract");
        require(IERC20(stake).totalSupply() != 0, "stake has no supply");

        vm.startBroadcast();
        ZapOverdraw game =
            new ZapOverdraw(stake, rakeRecipient, entryFee, commitWindow, revealWindow, rakeBps, keeperBps);
        vm.stopBroadcast();

        // Read every immutable BACK OFF THE DEPLOYED CONTRACT. Echoing the constructor arguments
        // would prove only that this script can print its own inputs.
        console2.log("ZapOverdraw     ", address(game));
        console2.log("  stake         ", game.stake());
        console2.log("  rakeRecipient ", game.rakeRecipient());
        console2.log("  entryFee      ", game.entryFee());
        console2.log("  commitWindow  ", game.commitWindow());
        console2.log("  revealWindow  ", game.revealWindow());
        console2.log("  rakeBps       ", game.rakeBps());
        console2.log("  keeperBps     ", game.keeperBps());
        console2.log("  round 1 open  ", game.currentRound());

        require(game.stake() == stake, "stake mismatch");
        require(game.rakeRecipient() == rakeRecipient, "rake recipient mismatch");
        require(game.entryFee() == entryFee, "entry fee mismatch");
        require(game.currentRound() == 1, "round 1 did not open");
    }
}
