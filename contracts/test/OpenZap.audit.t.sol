// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseTest} from "./Base.t.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Regression tests for the confirmed findings of the v1 multi-agent security audit.
contract AuditRegressionTest is BaseTest {
    // CRITICAL: create2-salt-collision-clone-hijack — address is bound to the full policy.
    function test_saltBoundToPolicy_preventsHijack() public {
        bytes32 salt = bytes32("victim-salt");
        Policy memory pVictim = _defaultPolicy();
        address victimAddr = factory.predict(pVictim, salt);

        Policy memory pAttacker = _defaultPolicy();
        pAttacker.owner = address(0xA77AC);
        pAttacker.recipient = address(0xA77AC);
        address attackerAddr = factory.predict(pAttacker, salt);

        assertTrue(victimAddr != attackerAddr, "distinct policy must map to distinct address");

        // Attacker front-runs with the same raw salt but a different policy: lands elsewhere.
        address deployed = factory.createZap(pAttacker, salt);
        assertEq(deployed, attackerAddr);
        assertTrue(deployed != victimAddr, "attacker cannot occupy victim's funded address");

        // Victim's funded address remains free for the victim's exact policy.
        assertEq(factory.createZap(pVictim, salt), victimAddr);
    }

    // HIGH: full-balance settlement -> measured delta only; standing principal is never swept.
    function test_settlementUsesRunDeltaNotStandingBalance() public {
        tokenOut.mint(address(zap), 50e18); // pre-existing principal that must NOT leave
        OpenZapIntent memory it = _defaultIntent();
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(recipient), 99e18, "recipient gets run delta only");
        assertEq(tokenOut.balanceOf(relayer), 1e18);
        assertEq(tokenOut.balanceOf(address(zap)), 50e18, "standing principal untouched");
    }

    function test_settlement_revertsIfNoRealOutput() public {
        // minOut satisfiable only from standing balance must now revert (delta == 0).
        tokenOut.mint(address(zap), 200e18);
        OpenZapIntent memory it = _defaultIntent();
        // Make the swap produce nothing by routing 0 via a zero-rate is not possible here; instead
        // assert the delta path: with a fresh produced 100e18 and standing 200e18, minOut above the
        // delta (e.g. 150) must fail because only the 100e18 delta counts.
        it.minOut = 150e18;
        vm.expectRevert(OpenZap.MinOutNotMet.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    // HIGH/MEDIUM: zero owner is rejected at init (would otherwise brick recovery + permit junk sigs).
    function test_rejects_zeroOwnerPolicy() public {
        Policy memory p = _defaultPolicy();
        p.owner = address(0);
        vm.expectRevert(OpenZap.ZeroOwner.selector);
        factory.createZap(p, bytes32("zero-owner"));
    }

    // MEDIUM: outAsset must be on the curated allowlist at execution.
    function test_rejects_outAssetNotAllowlisted() public {
        MockERC20 rogue = new MockERC20("X", "X", 18);
        OpenZapIntent memory it = _defaultIntent();
        it.outAsset = address(rogue);
        vm.expectRevert(abi.encodeWithSelector(OpenZap.TokenNotAllowed.selector, address(rogue)));
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    // MEDIUM: signed maxGas is now enforced on-chain (I-AUTH-4).
    function test_rejects_gasLimitAboveSignedCap() public {
        OpenZapIntent memory it = _defaultIntent();
        it.maxGas = 100_000; // the test forwards far more gas than this
        vm.expectRevert(OpenZap.GasLimitTooHigh.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    // LOW: policy size is bounded so an immutable clone can't be deployed permanently unexecutable.
    function test_rejects_tooManySteps() public {
        Policy memory p = _defaultPolicy();
        Step memory s = p.steps[0];
        Step[] memory many = new Step[](17);
        for (uint256 i; i < 17; ++i) {
            many[i] = s;
        }
        p.steps = many;
        vm.expectRevert(OpenZap.PolicyTooLarge.selector);
        factory.createZap(p, bytes32("too-many-steps"));
    }

    // LOW: two-step governance ownership transfer on the kill-switch registries.
    function test_registry_twoStepOwnership() public {
        address newOwner = address(0xACE);
        registry.transferOwnership(newOwner);
        assertEq(registry.owner(), address(this), "owner unchanged until accepted");
        assertEq(registry.pendingOwner(), newOwner);

        vm.prank(newOwner);
        registry.acceptOwnership();
        assertEq(registry.owner(), newOwner);
        assertEq(registry.pendingOwner(), address(0));
    }

    function test_registry_onlyPendingCanAccept() public {
        registry.transferOwnership(address(0xACE));
        vm.expectRevert(AdapterRegistry.NotPendingOwner.selector);
        registry.acceptOwnership(); // wrong caller (this contract is not pending)
    }
}
