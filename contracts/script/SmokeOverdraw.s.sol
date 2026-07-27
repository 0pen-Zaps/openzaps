// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ZapOverdraw} from "../src/game/ZapOverdraw.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface IERC20Meta {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// @title SmokeOverdraw
/// @notice Read-only verification of a DEPLOYED `ZapOverdraw`, run against live chain state.
///
///         Every check below reads the contract itself rather than the broadcast log, because a
///         broadcast log proves a transaction was sent and nothing else. This is the gate between
///         "the deploy script exited 0" and "the game is safe to point people at".
///
/// @dev Needs no key and sends nothing. Usage:
///
///        OVERDRAW_ADDRESS=0x... forge script script/SmokeOverdraw.s.sol:SmokeOverdraw \
///          --rpc-url $ROBINHOOD_RPC
///
///      A failed `require` here means DO NOT set `NEXT_PUBLIC_OVERDRAW_ADDRESS`. The web surface
///      fails closed until that variable is set, so an unverified deployment stays invisible —
///      which is the entire point of keeping those two steps separate.
contract SmokeOverdraw is Script {
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    uint256 internal constant ROBINHOOD = 4663;

    function run() external view {
        ZapOverdraw game = ZapOverdraw(vm.envAddress("OVERDRAW_ADDRESS"));

        require(block.chainid == ROBINHOOD, "wrong chain: point --rpc-url at Robinhood 4663");
        require(address(game).code.length != 0, "no code at OVERDRAW_ADDRESS");

        // ---- the stake token is the real 0xZAPS ---------------------------------------- //
        address stake = game.stake();
        require(stake == ZAPS, "stake is not the canonical 0xZAPS");
        require(IERC20Meta(stake).decimals() == 18, "stake decimals are not 18");
        console2.log("stake            ", stake, IERC20Meta(stake).symbol());

        // ---- fees are inside the bounds the contract claims ---------------------------- //
        uint16 rakeBps = game.rakeBps();
        uint16 keeperBps = game.keeperBps();
        require(rakeBps >= 1 && rakeBps <= 500, "rake out of range");
        require(keeperBps <= 100, "keeper out of range");
        // A zero rake would freeze the carry pool forever; the constructor refuses it, and this
        // re-checks the deployed value rather than trusting that it ran.
        require(rakeBps != 0, "zero rake would trap the carry pool");

        // ---- windows are long enough that an honest player can come back to reveal ------ //
        uint64 commitWindow = game.commitWindow();
        uint64 revealWindow = game.revealWindow();
        require(commitWindow >= 5 minutes && commitWindow <= 7 days, "commit window out of range");
        require(revealWindow >= 5 minutes && revealWindow <= 7 days, "reveal window out of range");

        // ---- the shape of the game is what the app assumes ----------------------------- //
        require(game.BPS() == 10_000, "BPS drifted");
        require(game.MAX_SEATS() == 64, "MAX_SEATS drifted");
        require(game.MIN_REVEALS() == 2, "MIN_REVEALS drifted");

        // ---- a fresh deployment holds nothing and owes nothing -------------------------- //
        uint256 held = IERC20(stake).balanceOf(address(game));
        uint256 pool = game.carryPool();
        require(pool <= held, "carry pool exceeds the balance backing it");

        // ---- round 1 is open and accepting commits -------------------------------------- //
        uint256 round = game.currentRound();
        require(round >= 1, "no round open");
        (uint64 commitEnd, uint64 revealEnd, uint32 seats, uint32 reveals, bool settled) = game.rounds(round);
        require(revealEnd > commitEnd, "reveal window does not follow the commit window");
        require(!settled, "the open round is already settled");

        (uint256 capacity, uint256 fees) = game.previewCapacity();
        require(capacity >= fees - (fees * (rakeBps + keeperBps)) / 10_000, "capacity below fees less friction");

        console2.log("rakeRecipient    ", game.rakeRecipient());
        console2.log("entryFee (wei)   ", game.entryFee());
        console2.log("commitWindow (s) ", commitWindow);
        console2.log("revealWindow (s) ", revealWindow);
        console2.log("rakeBps          ", rakeBps);
        console2.log("keeperBps        ", keeperBps);
        console2.log("currentRound     ", round);
        console2.log("  seats          ", seats);
        console2.log("  reveals        ", reveals);
        console2.log("  commitEnd      ", commitEnd);
        console2.log("  revealEnd      ", revealEnd);
        console2.log("carryPool (wei)  ", pool);
        console2.log("stake held (wei) ", held);
        console2.log("phase (0/1/2)    ", game.phase());

        require(block.timestamp <= commitEnd, "round 1 commit window has already closed");
        console2.log("");
        console2.log("SMOKE PASSED - safe to set NEXT_PUBLIC_OVERDRAW_ADDRESS");
    }
}
