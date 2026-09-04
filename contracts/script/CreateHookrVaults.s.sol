// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {HookedRangeVault} from "../src/primitives/HookedRangeVault.sol";
import {HookedRangeVaultFactory} from "../src/primitives/HookedRangeVaultFactory.sol";

/// @title CreateHookrVaults
/// @notice Permissionless follow-up to `DeployRobinhoodHookrLiquidity`: create `HookedRangeVault`s
///         on an already-deployed factory from ANY funded wallet, then print the `setToken`
///         calldata governance must apply for each new share token (or apply it directly when the
///         broadcaster is the allowlist owner). Serves every Hookr generation: a V5 HOOKR-quoted
///         pool names the shared V5 hook; a Modular V2/V3 market names its kernel or per-market
///         instance, which the factory admits through the coordinator's live record.
///
/// @dev ENVIRONMENT:
///        HOOKR_FACTORY     address    required — the deployed HookedRangeVaultFactory.
///        HOOKR_LP_TOKENS   address[]  V5 lane: token sides of HOOKR-quoted pools (hook pinned).
///                                     Default: the five live launches.
///        HOOKR_MARKETS     address[]  Modular lane: for each market, its SUBJECT token followed by
///                                     its HOOK instance, flattened (`subject,hook,subject,hook,…`).
///                                     Native-quoted markets only (currency0 = ETH). Default: none.
///      Every pool must already be initialized and, unless REQUIRE_POOL_LIQUIDITY=false, funded.
contract CreateHookrVaults is Script {
    address internal constant TOKEN_ALLOWLIST = 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    address internal constant HOOKR_HOOK_V5 = 0xe7c3461A4c762fF9dB4F91BeE3Cf8deAaFc2E8CC;
    uint24 internal constant DYNAMIC_FEE = 0x800000;
    int24 internal constant TICK_SPACING = 60;

    error MissingFactory();
    error OddMarketList();

    function run() external {
        address factoryAddress = vm.envAddress("HOOKR_FACTORY");
        if (factoryAddress == address(0) || factoryAddress.code.length == 0) revert MissingFactory();
        HookedRangeVaultFactory factory = HookedRangeVaultFactory(factoryAddress);
        TokenAllowlist allowlist = TokenAllowlist(TOKEN_ALLOWLIST);
        address[] memory tokens = vm.envOr("HOOKR_LP_TOKENS", ",", _defaultTokens());
        address[] memory markets = vm.envOr("HOOKR_MARKETS", ",", new address[](0));
        if (markets.length % 2 != 0) revert OddMarketList();

        uint256 count = tokens.length + markets.length / 2;
        address[] memory vaults = new address[](count);
        uint256 n;

        vm.startBroadcast();
        for (uint256 i = 0; i < tokens.length; i++) {
            (address c0, address c1) = tokens[i] < HOOKR ? (tokens[i], HOOKR) : (HOOKR, tokens[i]);
            vaults[n++] = _createOrReuse(factory, c0, c1, HOOKR_HOOK_V5);
        }
        for (uint256 i = 0; i < markets.length; i += 2) {
            vaults[n++] = _createOrReuse(factory, address(0), markets[i], markets[i + 1]);
        }
        if (msg.sender == allowlist.owner()) {
            for (uint256 i = 0; i < vaults.length; i++) {
                if (!allowlist.isAllowed(vaults[i])) allowlist.setToken(vaults[i], true);
            }
        }
        vm.stopBroadcast();

        console2.log("== CreateHookrVaults ==");
        for (uint256 i = 0; i < vaults.length; i++) {
            HookedRangeVault vault = HookedRangeVault(payable(vaults[i]));
            console2.log("vault", vaults[i]);
            console2.log("  symbol:", vault.symbol());
            console2.log("  poolId:");
            console2.logBytes32(vault.poolId());
            if (!allowlist.isAllowed(vaults[i])) {
                console2.log("  PENDING governance call on TokenAllowlist", TOKEN_ALLOWLIST);
                console2.logBytes(abi.encodeCall(TokenAllowlist.setToken, (vaults[i], true)));
            }
        }
    }

    function _createOrReuse(HookedRangeVaultFactory factory, address c0, address c1, address hooks)
        internal
        returns (address vault)
    {
        bytes32 poolId = keccak256(abi.encode(c0, c1, DYNAMIC_FEE, TICK_SPACING, hooks));
        vault = factory.vaultOf(poolId);
        if (vault == address(0)) vault = factory.createVault(c0, c1, DYNAMIC_FEE, TICK_SPACING, hooks);
    }

    function _defaultTokens() internal pure returns (address[] memory tokens) {
        tokens = new address[](5);
        tokens[0] = 0xeB322dBcE33c7fb44DD58B591C06eF2715AAf67C; // CANV5H
        tokens[1] = 0xBb371991468BD17d007a3Da6B400e6eD0CCd8807; // KRN
        tokens[2] = 0x8be7f9014653588dA3429d37e1CE52757D831F74; // TCL
        tokens[3] = 0xC450aF010fA4e46450BfBc78ea15A394a673F512; // HRFART
        tokens[4] = 0x50e58C8d92A3E9bbEf55e8Ef12743746C06255a9; // HOOKING
    }
}
