// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {HookedRangeVault} from "../src/primitives/HookedRangeVault.sol";
import {HookedRangeVaultFactory} from "../src/primitives/HookedRangeVaultFactory.sol";
import {HookedRangeDepositAdapter} from "../src/adapters/HookedRangeDepositAdapter.sol";
import {HookedRangeWithdrawAdapter} from "../src/adapters/HookedRangeWithdrawAdapter.sol";
import {HookrMarketSwapAdapter} from "../src/adapters/HookrMarketSwapAdapter.sol";

interface IPoolManagerRead {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title DeployRobinhoodHookrLiquidity
/// @notice Adds Hookr-pool liquidity zaps to the EXISTING, ALREADY-DEPLOYED OpenZap set on
///         Robinhood Chain (4663): zap in to, zap out of, and migrate between the HOOKR-quoted
///         pools the Hookr launchpad graduates (one shared hook `0xe7c3…E8CC`, dynamic fee, tick
///         spacing 60). Three contracts plus one vault per pool:
///
///           1. `HookedRangeVaultFactory(PoolManager, HookrHook, HOOKR)` — permissionless,
///              deterministic `HookedRangeVault` per pool. Anyone can call `createVault` for a
///              new launch; no OpenZaps deployment is needed per pool.
///           2. `HookedRangeDepositAdapter(PoolManager, factory)` — ONE adapter for every vault.
///           3. `HookedRangeWithdrawAdapter(PoolManager, factory)` — ONE adapter for every vault.
///           4. `createVault` for each pool in `HOOKR_LP_TOKENS` (default: the launches with live
///              liquidity at authoring time).
///
/// @dev THIS SCRIPT DEPLOYS NO CORE. Registry, allowlist and the v1.1 factory already exist on
///      4663 and are pinned below. NO KEY MATERIAL: the signer comes from the forge CLI.
///
///      WHO CAN DO WHAT: anyone can deploy the three contracts and create vaults. ONLY the live
///      registry owner can make them reachable: `AdapterRegistry.setAdapter` for both adapters
///      (once, ever) and `TokenAllowlist.setToken` for HOOKR and for EACH vault's share token
///      (the capsule refuses untracked assets at `createZap`). A new launch therefore costs one
///      permissionless `createVault` plus one governance `setToken(vault)`. The script takes the
///      governance branch only when the broadcaster IS the owner and prints exact calldata for
///      whatever remains.
///
///      AFTER a verified broadcast, configure the app (fail-closed until then):
///        NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_FACTORY=<factory>
///        NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_DEPOSIT_ADAPTER=<deposit adapter>
///        NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_WITHDRAW_ADAPTER=<withdraw adapter>
///      then bake the addresses (and the per-pool vault table) into `src/lib/hookr-pools.ts` in a
///      reviewed PR with independent explorer/RPC evidence recorded in docs/deployments.md.
///
///      ENVIRONMENT (all optional):
///        HOOKR_LP_TOKENS         address[]  comma-separated token sides of the HOOKR-quoted pools
///                                           to create vaults for. Default: the live set below.
///        CREATE_VAULTS           bool       default true. Set false to deploy and wire ONLY the
///                                           three contracts (owner work, ~11M gas); vault creation
///                                           is permissionless and can be broadcast from any funded
///                                           wallet afterwards with `CreateHookrVaults.s.sol`, which
///                                           prints the `setToken` calldata governance then applies.
///        REQUIRE_POOL_LIQUIDITY  bool       default true — refuse a vault for a dead pool.
///
///      WHAT THIS SCRIPT REFUSES TO DO:
///        * run on any chain but 4663;
///        * run against a v1.1 factory not wired to the pinned registries;
///        * create a vault for a pool whose hook is not the pinned Hookr hook (structural: the
///          factory pins the hook) or that has no liquidity (unless REQUIRE_POOL_LIQUIDITY=false);
///        * claim a governance call happened when it did not.
contract DeployRobinhoodHookrLiquidity is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    address internal constant ADAPTER_REGISTRY = 0x9E56e444f490C00A6277326A47Cb462E12dF1f17;
    address internal constant TOKEN_ALLOWLIST = 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B;
    address internal constant OPENZAP_V1_1_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;

    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c;
    /// @dev The V5 launchpad's shared hook (hookr.fun/docs; verified with the launchpad source).
    address internal constant HOOKR_HOOK = 0xe7c3461A4c762fF9dB4F91BeE3Cf8deAaFc2E8CC;
    /// @dev Hookr Modular V2: the shared root hook (`HookrSwapKernelV1`) and the two coordinator
    ///      graphs that exist on chain (the canary graph holding the only V2 market, and the
    ///      post-canary graph). Modular V3 binds a per-market hook INSTANCE, so its coordinator's
    ///      live market records — not a static hook — admit V3 pools. All three coordinators
    ///      bound the market swap adapter and the factory's instance admission.
    address internal constant HOOKR_KERNEL_V2 = 0x26734cc3b9678966d881559963E5Db117f9228CC;
    address internal constant HOOKR_COORDINATOR_V2_CANARY = 0xa7DA0A9234197670d203Cba091a041e6Bcc297a5;
    address internal constant HOOKR_COORDINATOR_V2 = 0x9B824615D3836BdC668fBe80bB5A50391765787f;
    address internal constant HOOKR_COORDINATOR_V3 = 0x7b554efa746a76A2297489B2E8C2De6f19a3b59D;

    uint24 internal constant DYNAMIC_FEE = 0x800000;
    int24 internal constant TICK_SPACING = 60;

    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    error WrongChain(uint256 actual);
    error MissingCode(address target);
    error FactoryNotWiredToPinnedGovernance(address factory);
    error DeadPool(address token, bytes32 poolId);
    error DeploymentAssertionFailed();

    struct Deployed {
        HookedRangeVaultFactory factory;
        HookedRangeDepositAdapter depositAdapter;
        HookedRangeWithdrawAdapter withdrawAdapter;
        HookrMarketSwapAdapter marketSwapAdapter;
        address[] tokens;
        address[] vaults;
    }

    function run() external returns (Deployed memory d) {
        address deployer = msg.sender;
        bool requireLiquidity = vm.envOr("REQUIRE_POOL_LIQUIDITY", true);
        bool createVaults = vm.envOr("CREATE_VAULTS", true);
        address[] memory tokens = createVaults ? vm.envOr("HOOKR_LP_TOKENS", ",", _defaultTokens()) : new address[](0);

        AdapterRegistry registry = AdapterRegistry(ADAPTER_REGISTRY);
        TokenAllowlist allowlist = TokenAllowlist(TOKEN_ALLOWLIST);

        _preflight(tokens, requireLiquidity);

        vm.startBroadcast();

        address[] memory hooks = new address[](2);
        hooks[0] = HOOKR_HOOK;
        hooks[1] = HOOKR_KERNEL_V2;
        address[] memory coordinators = _coordinators();
        d.factory = new HookedRangeVaultFactory(POOL_MANAGER, AEWETH, HOOKR, hooks, coordinators);
        d.depositAdapter = new HookedRangeDepositAdapter(POOL_MANAGER, AEWETH, address(d.factory));
        d.withdrawAdapter = new HookedRangeWithdrawAdapter(POOL_MANAGER, AEWETH, address(d.factory));
        d.marketSwapAdapter = new HookrMarketSwapAdapter(POOL_MANAGER, AEWETH, coordinators);

        d.tokens = tokens;
        d.vaults = new address[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            (address c0, address c1) = _sorted(tokens[i]);
            d.vaults[i] = d.factory.createVault(c0, c1, DYNAMIC_FEE, TICK_SPACING, HOOKR_HOOK);
        }

        if (deployer == registry.owner()) {
            registry.setAdapter(address(d.depositAdapter), true);
            registry.setAdapter(address(d.withdrawAdapter), true);
            registry.setAdapter(address(d.marketSwapAdapter), true);
        }
        if (deployer == allowlist.owner()) {
            if (!allowlist.isAllowed(HOOKR)) allowlist.setToken(HOOKR, true);
            for (uint256 i = 0; i < d.vaults.length; i++) {
                allowlist.setToken(d.vaults[i], true);
            }
        }

        vm.stopBroadcast();

        _assertDeployment(d);
        _report(d);
        _reportGovernanceWork(d, registry, allowlist);
    }

    function _assertDeployment(Deployed memory d) internal view {
        if (
            d.factory.poolManager() != POOL_MANAGER || d.factory.weth() != AEWETH || d.factory.quote() != HOOKR
                || !d.factory.isAllowedHook(HOOKR_HOOK) || !d.factory.isAllowedHook(HOOKR_KERNEL_V2)
                || address(d.depositAdapter.factory()) != address(d.factory)
                || address(d.withdrawAdapter.factory()) != address(d.factory)
                || d.marketSwapAdapter.coordinators().length != 3 || d.factory.coordinators().length != 3
                || d.marketSwapAdapter.coordinators()[0] != HOOKR_COORDINATOR_V3
                || d.factory.coordinators()[0] != HOOKR_COORDINATOR_V3
                || d.factory.vaultCount() != d.vaults.length
        ) revert DeploymentAssertionFailed();
        for (uint256 i = 0; i < d.vaults.length; i++) {
            HookedRangeVault vault = HookedRangeVault(payable(d.vaults[i]));
            (address c0, address c1) = _sorted(d.tokens[i]);
            if (
                !d.factory.isVault(d.vaults[i]) || vault.currency0() != c0 || vault.currency1() != c1
                    || vault.hooks() != HOOKR_HOOK || vault.fee() != DYNAMIC_FEE || vault.tickSpacing() != TICK_SPACING
                    || vault.currentSqrtPriceX96() == 0
            ) revert DeploymentAssertionFailed();
        }
    }

    function _preflight(address[] memory tokens, bool requireLiquidity) internal view {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);
        _requireCode(ADAPTER_REGISTRY);
        _requireCode(TOKEN_ALLOWLIST);
        _requireCode(OPENZAP_V1_1_FACTORY);
        _requireCode(POOL_MANAGER);
        _requireCode(HOOKR);
        _requireCode(HOOKR_HOOK);
        _requireCode(HOOKR_KERNEL_V2);
        _requireCode(HOOKR_COORDINATOR_V3);
        _requireCode(HOOKR_COORDINATOR_V2);
        _requireCode(HOOKR_COORDINATOR_V2_CANARY);
        _requireCode(AEWETH);

        OpenZapFactory v1 = OpenZapFactory(OPENZAP_V1_1_FACTORY);
        if (address(v1.adapters()) != ADAPTER_REGISTRY || address(v1.tokens()) != TOKEN_ALLOWLIST) {
            revert FactoryNotWiredToPinnedGovernance(OPENZAP_V1_1_FACTORY);
        }

        for (uint256 i = 0; i < tokens.length; i++) {
            _requireCode(tokens[i]);
            (address c0, address c1) = _sorted(tokens[i]);
            bytes32 poolId = keccak256(abi.encode(c0, c1, DYNAMIC_FEE, TICK_SPACING, HOOKR_HOOK));
            if (requireLiquidity && _liquidity(poolId) == 0) revert DeadPool(tokens[i], poolId);
        }
    }

    /// @dev Launches with live liquidity in their HOOKR-quoted Hookr pool at authoring time
    ///      (2026-09-04, read off the PoolManager). Override with HOOKR_LP_TOKENS.
    function _defaultTokens() internal pure returns (address[] memory tokens) {
        tokens = new address[](5);
        tokens[0] = 0xeB322dBcE33c7fb44DD58B591C06eF2715AAf67C; // CANV5H — Canary Hookr Pair V5
        tokens[1] = 0xBb371991468BD17d007a3Da6B400e6eD0CCd8807; // KRN — Kraken Club
        tokens[2] = 0x8be7f9014653588dA3429d37e1CE52757D831F74; // TCL — Tentacle
        tokens[3] = 0xC450aF010fA4e46450BfBc78ea15A394a673F512; // HRFART — HOOKR FART
        tokens[4] = 0x50e58C8d92A3E9bbEf55e8Ef12743746C06255a9; // HOOKING
    }

    /// @dev Coordinators in lookup order: the current release first.
    function _coordinators() internal pure returns (address[] memory coordinators) {
        coordinators = new address[](3);
        coordinators[0] = HOOKR_COORDINATOR_V3;
        coordinators[1] = HOOKR_COORDINATOR_V2;
        coordinators[2] = HOOKR_COORDINATOR_V2_CANARY;
    }

    function _sorted(address token) internal pure returns (address c0, address c1) {
        return token < HOOKR ? (token, HOOKR) : (HOOKR, token);
    }

    function _liquidity(bytes32 poolId) internal view returns (uint256) {
        bytes32 stateSlot = keccak256(abi.encode(poolId, POOLS_SLOT));
        return uint256(IPoolManagerRead(POOL_MANAGER).extsload(bytes32(uint256(stateSlot) + LIQUIDITY_OFFSET)));
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    function _report(Deployed memory d) internal view {
        console2.log("== DeployRobinhoodHookrLiquidity ==");
        console2.log("HookedRangeVaultFactory:", address(d.factory));
        console2.log("HookedRangeDepositAdapter:", address(d.depositAdapter));
        console2.log("HookedRangeWithdrawAdapter:", address(d.withdrawAdapter));
        console2.log("HookrMarketSwapAdapter:", address(d.marketSwapAdapter));
        for (uint256 i = 0; i < d.vaults.length; i++) {
            console2.log("vault for token", d.tokens[i]);
            console2.log("  ->", d.vaults[i]);
            console2.log("  symbol:", HookedRangeVault(payable(d.vaults[i])).symbol());
        }
        console2.log("");
        console2.log("App env (set only after independent verification):");
        console2.log("  NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_FACTORY=", address(d.factory));
        console2.log("  NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_DEPOSIT_ADAPTER=", address(d.depositAdapter));
        console2.log("  NEXT_PUBLIC_OPENZAP_HOOKR_RANGE_WITHDRAW_ADAPTER=", address(d.withdrawAdapter));
        console2.log("  NEXT_PUBLIC_OPENZAP_HOOKR_MARKET_SWAP_ADAPTER=", address(d.marketSwapAdapter));
    }

    function _reportGovernanceWork(Deployed memory d, AdapterRegistry registry, TokenAllowlist allowlist)
        internal
        view
    {
        bool pending;
        if (!registry.isAllowed(address(d.depositAdapter))) {
            pending = true;
            console2.log("PENDING governance call on AdapterRegistry", address(registry));
            console2.logBytes(abi.encodeCall(AdapterRegistry.setAdapter, (address(d.depositAdapter), true)));
        }
        if (!registry.isAllowed(address(d.withdrawAdapter))) {
            pending = true;
            console2.log("PENDING governance call on AdapterRegistry", address(registry));
            console2.logBytes(abi.encodeCall(AdapterRegistry.setAdapter, (address(d.withdrawAdapter), true)));
        }
        if (!registry.isAllowed(address(d.marketSwapAdapter))) {
            pending = true;
            console2.log("PENDING governance call on AdapterRegistry", address(registry));
            console2.logBytes(abi.encodeCall(AdapterRegistry.setAdapter, (address(d.marketSwapAdapter), true)));
        }
        if (!allowlist.isAllowed(HOOKR)) {
            pending = true;
            console2.log("PENDING governance call on TokenAllowlist", address(allowlist));
            console2.logBytes(abi.encodeCall(TokenAllowlist.setToken, (HOOKR, true)));
        }
        for (uint256 i = 0; i < d.vaults.length; i++) {
            if (!allowlist.isAllowed(d.vaults[i])) {
                pending = true;
                console2.log("PENDING governance call on TokenAllowlist", address(allowlist));
                console2.logBytes(abi.encodeCall(TokenAllowlist.setToken, (d.vaults[i], true)));
            }
        }
        if (!pending) {
            console2.log("All governance wiring complete: both adapters, HOOKR, and every vault share token are allowlisted.");
        }
    }
}
