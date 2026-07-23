// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {DeployEverything} from "./DeployEverything.s.sol";

/// @title DeployNodarRobinhood
/// @notice The Robinhood Chain (4663) deployment, pinned to `nodar.eth`.
/// @dev nodar.eth resolves to 0x5a52D4B820Ae7F02880d270562950918ACb14aA2 (a plain EOA, verified
///      onchain). That address is already the *pendingOwner* of the live AdapterRegistry
///      (0x9E56e444f490C00A6277326A47Cb462E12dF1f17) and TokenAllowlist
///      (0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B) — the ownership handoff was proposed but never
///      accepted, so 0xe17f5150… is still the live owner today.
///
///      PREREQUISITE, or the governance wiring only prints as PENDING instead of executing:
///      nodar.eth must first accept ownership of both contracts, which makes it the owner so this
///      script's setAdapter/setToken calls run in the same broadcast:
///
///        cast send 0x9E56e444f490C00A6277326A47Cb462E12dF1f17 "acceptOwnership()" \
///          --rpc-url https://rpc.mainnet.chain.robinhood.com --account <nodar-keystore>
///        cast send 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B "acceptOwnership()" \
///          --rpc-url https://rpc.mainnet.chain.robinhood.com --account <nodar-keystore>
///
///      This script ADDS to the live v1.1 core (it never redeploys the factory). It deploys the
///      aeWETH/USDG pool swap adapter, the ZapVault, and the vault deposit+redeem adapters, and — once
///      nodar owns governance — allowlists every new adapter and token in the same run.
///
///      Run (nodar signs; no key is ever in this repo):
///        VAULT_SEED_ASSETS=0 forge script script/DeployNodarRobinhood.s.sol \
///          --rpc-url https://rpc.mainnet.chain.robinhood.com \
///          --account <nodar-keystore> --sender 0x5a52D4B820Ae7F02880d270562950918ACb14aA2 \
///          --broadcast --slow
///
///      VAULT_SEED_ASSETS=0 is set because nodar.eth holds 0 USDG today, so the default seeded run
///      (1 USDG into the vault) would abort in preflight. Seed the vault with >= 1 USDG before wiring
///      its share token into the frontend; the swap adapter is usable immediately, unseeded.
///
///      NO KEY MATERIAL. `vm.startBroadcast()` (inherited) takes no argument; the signer comes from
///      forge's --account/--ledger. This file only pins the governance address.
contract DeployNodarRobinhood is DeployEverything {
    /// @dev nodar.eth
    address internal constant NODAR = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;

    function _governance() internal pure override returns (address) {
        return NODAR;
    }

    function run() public override {
        require(block.chainid == ROBINHOOD_CHAIN_ID, "DeployNodarRobinhood: run against Robinhood Chain (4663)");
        require(msg.sender == NODAR, "DeployNodarRobinhood: --sender must be nodar.eth (0x5a52...4aA2)");
        super.run();
    }
}
