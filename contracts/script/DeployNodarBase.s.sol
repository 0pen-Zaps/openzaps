// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {DeployEverything} from "./DeployEverything.s.sol";

/// @title DeployNodarBase
/// @notice The Base mainnet (8453) deployment, pinned to `nodar.eth`.
/// @dev nodar.eth resolves to 0x5a52D4B820Ae7F02880d270562950918ACb14aA2 (verified onchain). On Base
///      there is no existing OpenZaps core owned by nodar — the old factory
///      0xc7C5897e4738a157731c2F93b1d73Db9926E926C is a superseded v1.0.0 owned by nobody relevant —
///      so this deploys a FRESH v1.1 core (implementation, factory, registry, allowlist), then the
///      Base swap, Aave supply, and Aave withdraw adapters, allowlists them and their tokens, and
///      PROPOSES two-step ownership of the registry + allowlist to nodar.eth.
///
///      Because nodar is the deployer here, the allowlisting runs in the same broadcast, and the
///      ownership proposal is to nodar itself — so nodar must finish the handoff afterwards:
///        cast send <registry> "acceptOwnership()" --rpc-url https://mainnet.base.org --account <nodar-keystore>
///        cast send <allowlist> "acceptOwnership()" --rpc-url https://mainnet.base.org --account <nodar-keystore>
///
///      Run (nodar signs; no key is ever in this repo):
///        forge script script/DeployNodarBase.s.sol \
///          --rpc-url https://mainnet.base.org \
///          --account <nodar-keystore> --sender 0x5a52D4B820Ae7F02880d270562950918ACb14aA2 \
///          --broadcast --slow --verify
///
///      This is NOT idempotent: a second broadcast stands up a second, disconnected core. Run once.
///      NO KEY MATERIAL — the signer comes from forge's --account/--ledger.
contract DeployNodarBase is DeployEverything {
    /// @dev nodar.eth
    address internal constant NODAR = 0x5a52D4B820Ae7F02880d270562950918ACb14aA2;

    function _governance() internal pure override returns (address) {
        return NODAR;
    }

    function run() public override {
        require(block.chainid == BASE_CHAIN_ID, "DeployNodarBase: run against Base mainnet (8453)");
        require(msg.sender == NODAR, "DeployNodarBase: --sender must be nodar.eth (0x5a52...4aA2)");
        super.run();
    }
}
