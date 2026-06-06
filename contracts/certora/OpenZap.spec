/*
 * OpenZap v1 — Certora (CVL) rule sketches.
 * ILLUSTRATIVE: requires a Certora Prover license + CI harness to run. See README.md.
 * Maps to invariant IDs in ../../docs/invariant-spec.md.
 */

using OpenZap as zap;

methods {
    function policyHash() external returns (bytes32) envfree;
    function owner() external returns (address) envfree;
    function nonceUsed(uint256) external returns (bool) envfree;
}

/// I-AUTH-3: execute must revert unless the intent's policyHash equals the frozen policyHash.
rule policyHashIsImmutableGate(bytes32 intentPolicyHash) {
    env e;
    require intentPolicyHash != policyHash();
    // A call carrying a foreign policyHash must not succeed.
    // (Harness: construct an OpenZapIntent with .policyHash = intentPolicyHash and call execute.)
    assert lastReverted, "execute accepted a foreign policyHash";
}

/// I-AUTH-2: a consumed nonce is monotone — once true, never false again.
rule nonceConsumedOnce(method f, uint256 n) {
    env e; calldataarg args;
    bool usedBefore = nonceUsed(n);
    f(e, args);
    bool usedAfter = nonceUsed(n);
    assert usedBefore => usedAfter, "a consumed nonce was un-consumed";
}

/// I-APPR-1: no externally-observable residual approval persists across a completed execute.
/// (Harness: ghost-track allowance writes; assert allowance == 0 at execute() exit for every spender.)
invariant noResidualApproval()
    true // placeholder — bind to an allowance ghost in the harness
    { preserved { require true; } }

/// I-ISO-3: initialize is callable at most once and only by the factory.
rule initializeOnce(method f) filtered { f -> f.selector == sig:initialize(OpenZap.Policy).selector } {
    env e; calldataarg args;
    address ownerBefore = owner();
    require ownerBefore != 0; // already initialized
    f@withrevert(e, args);
    assert lastReverted, "re-initialization succeeded";
}

/// I-REC-1: emergencyExit is owner-gated and never reverts for the owner due to internal policy state.
rule emergencyExitOwnerOnly(method f) filtered { f -> f.selector == sig:emergencyExit(address[]).selector } {
    env e; calldataarg args;
    f@withrevert(e, args);
    assert (!lastReverted) => (e.msg.sender == owner()), "emergencyExit ran for a non-owner";
}
