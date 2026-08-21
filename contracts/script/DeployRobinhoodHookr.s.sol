// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {OpenZapFactoryV3} from "../src/v3/OpenZapFactoryV3.sol";
import {RobinhoodV4NativePoolAdapter} from "../src/adapters/RobinhoodV4NativePoolAdapter.sol";
import {V4PoolPriceSource} from "../src/v3/V4PoolPriceSource.sol";
import {V4PoolPriceSourceOriented} from "../src/v3_1/V4PoolPriceSourceOriented.sol";

/// @dev Read-only window into the v4 PoolManager, used to refuse a dead pool at deploy time.
interface IPoolManagerRead {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title DeployRobinhoodHookr
/// @notice Adds the HOOKR expansion to the EXISTING, ALREADY-DEPLOYED OpenZap set on Robinhood
///         Chain (4663) — the three contracts that make HOOKR buy, DCA, and price-triggered zaps
///         executable through the token's only real market, the hookless native-ETH/HOOKR pool
///         `0x590dcb6a…5fdf`:
///
///           1. `RobinhoodV4NativePoolAdapter` — the swap step. The pool's currency0 is native
///              ETH, which every existing adapter refuses and the capsule cannot settle, so this
///              adapter welds the wrap boundary into the step: aeWETH in → unwrap → swap → HOOKR
///              out (and the reverse), swapping the canonical PoolManager directly through its own
///              unlock callback. One deployment serves both directions of exactly this pool.
///           2. `V4PoolPriceSource` — the v3 TRIGGER oracle for the pool: HOOKR-per-ETH spot,
///              Q96, read straight off slot0. An arming condition, not a fair-value oracle.
///           3. `V4PoolPriceSourceOriented` — the v3.1 RELATIVE-FLOOR source for HOOKR DCA.
///              `currency0` is DECLARED as aeWETH, not the pool key's literal native zero, ON
///              PURPOSE: `executeRecurringRelative` derives the run's input asset from the
///              source's currencies and measures that ERC-20's spent balance, and the capsule
///              spends aeWETH (the adapter unwraps it 1:1). HOOKR-per-ETH IS HOOKR-per-aeWETH; a
///              literal zero would make the capsule call `balanceOf` on `address(0)` and brick
///              every run. The fork rehearsal (`RobinhoodV4NativePoolAdapter.fork.t.sol`) proves
///              this declaration through the LIVE v3.1 factory.
///
/// @dev THIS SCRIPT DEPLOYS NO CORE. Registries, allowlists, factories and price-source
///      registries already exist on 4663 and are pinned below.
///
///      NO KEY MATERIAL. `vm.startBroadcast()` takes no argument: the signer comes from the forge
///      CLI (`--ledger`, `--trezor`, `--account`, `--interactive`) and the deployer address is
///      whatever `--sender` names.
///
///      WHO CAN DO WHAT: anyone can deploy the three contracts. ONLY the live registry owners can
///      make them reachable: `AdapterRegistry.setAdapter` for the adapter,
///      `TokenAllowlist.setToken` for HOOKR (without which every HOOKR policy is refused at
///      `createZap`), and `setAdapter` on the v3 / v3.1 price-source registries for the two
///      sources. The script checks each `owner()` live, takes the branch actually available, and
///      prints exact calldata for whatever is left — it never claims a governance call happened
///      when it did not.
///
///      The v3.2 stack lineage is deliberately NOT wired: its stack leg converts output through
///      the welded aeWETH→0xZAPS adapter, which cannot take HOOKR, so HOOKR recurring signs the
///      v3.1 relative-floor path instead.
///
///      AFTER a verified broadcast, configure the app (fail-closed until then):
///        NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_HOOKR_ADAPTER=<adapter>
///        NEXT_PUBLIC_OPENZAP_HOOKR_POOL_PRICE_SOURCE=<trigger source>
///        NEXT_PUBLIC_OPENZAP_HOOKR_ORIENTED_PRICE_SOURCE=<oriented source>
///      then bake the addresses into `src/lib/robinhood.ts` / `src/lib/chains.ts` in a reviewed PR
///      with independent explorer/RPC evidence recorded in docs/deployments.md.
///
///      ENVIRONMENT (all optional):
///        GOVERNANCE             address  reporting only. Default: live `AdapterRegistry.owner()`.
///        REQUIRE_POOL_LIQUIDITY bool     default true — refuse to deploy against a dead pool.
///
///      WHAT THIS SCRIPT REFUSES TO DO:
///        * run on any chain but 4663;
///        * run against factories that are not wired to the pinned registries;
///        * deploy against a pool whose id does not match the pinned, measured id;
///        * deploy against a dead pool (unless REQUIRE_POOL_LIQUIDITY=false);
///        * claim a governance call happened when it did not.
contract DeployRobinhoodHookr is Script {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    // --- live OpenZap deployment, from src/lib/robinhood.ts ------------------------------------- //
    address internal constant ADAPTER_REGISTRY = 0x9E56e444f490C00A6277326A47Cb462E12dF1f17;
    address internal constant TOKEN_ALLOWLIST = 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B;
    address internal constant OPENZAP_V1_1_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;
    address internal constant OPENZAP_V3_FACTORY = 0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9;
    address internal constant OPENZAP_V3_1_FACTORY = 0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1;
    address internal constant V3_PRICE_SOURCES = 0xd83a2dedb6185395A1Ac1d0abb9F98472feAd574;
    address internal constant V3_1_PRICE_SOURCES = 0x76CB210F25D016078E10DbfCb19AFfBbB4892e33;

    // --- Uniswap v4 on Robinhood Chain ---------------------------------------------------------- //
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    // --- tokens --------------------------------------------------------------------------------- //
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // 18dp
    address internal constant HOOKR = 0x18E674231A58c239Dc7DaeDcffE15Ec3A24cff5c; // 18dp

    // --- the measured HOOKR pool: native ETH / HOOKR, hookless, static fee ---------------------- //
    uint24 internal constant POOL_FEE = 2500;
    int24 internal constant POOL_TICK_SPACING = 25;
    bytes32 internal constant POOL_ID = 0x590dcb6a87828bf688b48089a62239b693378f1fb64d2286e6a399ed8c005fdf;

    /// @dev v4 `StateLibrary.POOLS_SLOT`, and the offset of `Pool.State.liquidity` inside it.
    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    error WrongChain(uint256 actual);
    error MissingCode(address target);
    error ZeroGovernance();
    error FactoryNotWiredToPinnedGovernance(address factory);
    error PoolIdDrifted(bytes32 expected, bytes32 actual);
    error DeadPool(bytes32 poolId);
    error DeploymentAssertionFailed();

    struct Config {
        address deployer;
        address governance;
        bool requireLiquidity;
    }

    struct Deployed {
        RobinhoodV4NativePoolAdapter adapter;
        V4PoolPriceSource triggerSource;
        V4PoolPriceSourceOriented orientedSource;
    }

    function run() external returns (Deployed memory d) {
        Config memory cfg = _config();

        AdapterRegistry registry = AdapterRegistry(ADAPTER_REGISTRY);
        TokenAllowlist allowlist = TokenAllowlist(TOKEN_ALLOWLIST);
        AdapterRegistry v3Sources = AdapterRegistry(V3_PRICE_SOURCES);
        AdapterRegistry v3_1Sources = AdapterRegistry(V3_1_PRICE_SOURCES);

        _preflight(cfg);

        // ---- deploy --------------------------------------------------------------------------- //
        vm.startBroadcast();

        d.adapter = new RobinhoodV4NativePoolAdapter(AEWETH, POOL_MANAGER, HOOKR, POOL_FEE, POOL_TICK_SPACING, POOL_ID);
        d.triggerSource = new V4PoolPriceSource(POOL_MANAGER, POOL_ID);
        d.orientedSource = new V4PoolPriceSourceOriented(POOL_MANAGER, POOL_ID, AEWETH, HOOKR);

        // ---- governance wiring, only where the deployer actually has the right ----------------- //
        if (cfg.deployer == registry.owner()) {
            registry.setAdapter(address(d.adapter), true);
        }
        if (cfg.deployer == allowlist.owner()) {
            if (!allowlist.isAllowed(HOOKR)) allowlist.setToken(HOOKR, true);
        }
        if (cfg.deployer == v3Sources.owner()) {
            v3Sources.setAdapter(address(d.triggerSource), true);
        }
        if (cfg.deployer == v3_1Sources.owner()) {
            v3_1Sources.setAdapter(address(d.orientedSource), true);
        }

        vm.stopBroadcast();

        _assertDeployment(d);
        _report(cfg, d);
        _reportGovernanceWork(d, registry, allowlist, v3Sources, v3_1Sources);
    }

    function _assertDeployment(Deployed memory d) internal view {
        // The adapter is welded to exactly the measured pool and presents the wrapped pair.
        if (
            d.adapter.poolId() != POOL_ID || d.adapter.weth() != AEWETH || d.adapter.currency1() != HOOKR
                || address(d.adapter.poolManager()) != POOL_MANAGER
        ) revert DeploymentAssertionFailed();
        // Both sources read the same live pool and agree; the oriented one declares the wrapped
        // pair the capsule actually measures.
        if (
            d.triggerSource.poolId() != POOL_ID || d.orientedSource.poolId() != POOL_ID
                || d.triggerSource.priceX96() == 0 || d.orientedSource.priceX96() != d.triggerSource.priceX96()
                || d.orientedSource.currency0() != AEWETH || d.orientedSource.currency1() != HOOKR
        ) revert DeploymentAssertionFailed();
    }

    // ------------------------------------------------------------------------------------------- //
    // Configuration & preflight                                                                   //
    // ------------------------------------------------------------------------------------------- //

    function _config() internal view returns (Config memory cfg) {
        cfg.deployer = msg.sender;
        cfg.governance = vm.envOr("GOVERNANCE", AdapterRegistry(ADAPTER_REGISTRY).owner());
        if (cfg.governance == address(0)) revert ZeroGovernance();
        cfg.requireLiquidity = vm.envOr("REQUIRE_POOL_LIQUIDITY", true);
    }

    function _preflight(Config memory cfg) internal view {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        _requireCode(ADAPTER_REGISTRY);
        _requireCode(TOKEN_ALLOWLIST);
        _requireCode(OPENZAP_V1_1_FACTORY);
        _requireCode(OPENZAP_V3_FACTORY);
        _requireCode(OPENZAP_V3_1_FACTORY);
        _requireCode(V3_PRICE_SOURCES);
        _requireCode(V3_1_PRICE_SOURCES);
        _requireCode(POOL_MANAGER);
        _requireCode(AEWETH);
        _requireCode(HOOKR);

        // Every lineage a HOOKR zap can sign against must be wired to the pinned registries: the
        // one-shot factory to the adapter registry + allowlist, and the two automation factories
        // to those plus their own price-source registry.
        OpenZapFactory v1 = OpenZapFactory(OPENZAP_V1_1_FACTORY);
        if (address(v1.adapters()) != ADAPTER_REGISTRY || address(v1.tokens()) != TOKEN_ALLOWLIST) {
            revert FactoryNotWiredToPinnedGovernance(OPENZAP_V1_1_FACTORY);
        }
        OpenZapFactoryV3 v3 = OpenZapFactoryV3(OPENZAP_V3_FACTORY);
        if (
            address(v3.adapters()) != ADAPTER_REGISTRY || address(v3.tokens()) != TOKEN_ALLOWLIST
                || address(v3.priceSources()) != V3_PRICE_SOURCES
        ) revert FactoryNotWiredToPinnedGovernance(OPENZAP_V3_FACTORY);
        OpenZapFactoryV3 v3_1 = OpenZapFactoryV3(OPENZAP_V3_1_FACTORY);
        if (
            address(v3_1.adapters()) != ADAPTER_REGISTRY || address(v3_1.tokens()) != TOKEN_ALLOWLIST
                || address(v3_1.priceSources()) != V3_1_PRICE_SOURCES
        ) revert FactoryNotWiredToPinnedGovernance(OPENZAP_V3_1_FACTORY);

        // The pinned id must still be what (native, HOOKR, 2500, 25, hookless) hashes to, and the
        // pool must be alive: a zero-liquidity pool would make every zap revert at execution.
        bytes32 computed = keccak256(abi.encode(address(0), HOOKR, POOL_FEE, POOL_TICK_SPACING, address(0)));
        if (computed != POOL_ID) revert PoolIdDrifted(POOL_ID, computed);
        if (cfg.requireLiquidity && _liquidity(POOL_ID) == 0) revert DeadPool(POOL_ID);
    }

    function _liquidity(bytes32 poolId) internal view returns (uint256) {
        bytes32 stateSlot = keccak256(abi.encode(poolId, POOLS_SLOT));
        return uint256(IPoolManagerRead(POOL_MANAGER).extsload(bytes32(uint256(stateSlot) + LIQUIDITY_OFFSET)));
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    // ------------------------------------------------------------------------------------------- //
    // Reporting                                                                                   //
    // ------------------------------------------------------------------------------------------- //

    function _report(Config memory cfg, Deployed memory d) internal view {
        console2.log("== DeployRobinhoodHookr ==");
        console2.log("deployer:", cfg.deployer);
        console2.log("governance (reporting):", cfg.governance);
        console2.log("RobinhoodV4NativePoolAdapter:", address(d.adapter));
        console2.log("V4PoolPriceSource (v3 trigger):", address(d.triggerSource));
        console2.log("V4PoolPriceSourceOriented (v3.1 DCA):", address(d.orientedSource));
        console2.log("pool spot priceX96:", d.triggerSource.priceX96());
        console2.log("");
        console2.log("App env (set only after independent verification):");
        console2.log("  NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_HOOKR_ADAPTER=", address(d.adapter));
        console2.log("  NEXT_PUBLIC_OPENZAP_HOOKR_POOL_PRICE_SOURCE=", address(d.triggerSource));
        console2.log("  NEXT_PUBLIC_OPENZAP_HOOKR_ORIENTED_PRICE_SOURCE=", address(d.orientedSource));
    }

    function _reportGovernanceWork(
        Deployed memory d,
        AdapterRegistry registry,
        TokenAllowlist allowlist,
        AdapterRegistry v3Sources,
        AdapterRegistry v3_1Sources
    ) internal view {
        bool anyPending;
        if (!registry.isAllowed(address(d.adapter))) {
            anyPending = true;
            console2.log("PENDING governance call on AdapterRegistry", address(registry));
            console2.logBytes(abi.encodeCall(AdapterRegistry.setAdapter, (address(d.adapter), true)));
        }
        if (!allowlist.isAllowed(HOOKR)) {
            anyPending = true;
            console2.log("PENDING governance call on TokenAllowlist", address(allowlist));
            console2.logBytes(abi.encodeCall(TokenAllowlist.setToken, (HOOKR, true)));
        }
        if (!v3Sources.isAllowed(address(d.triggerSource))) {
            anyPending = true;
            console2.log("PENDING governance call on v3 price-source registry", address(v3Sources));
            console2.logBytes(abi.encodeCall(AdapterRegistry.setAdapter, (address(d.triggerSource), true)));
        }
        if (!v3_1Sources.isAllowed(address(d.orientedSource))) {
            anyPending = true;
            console2.log("PENDING governance call on v3.1 price-source registry", address(v3_1Sources));
            console2.logBytes(abi.encodeCall(AdapterRegistry.setAdapter, (address(d.orientedSource), true)));
        }
        if (!anyPending) {
            console2.log("All governance wiring complete: adapter, HOOKR token, and both sources are allowlisted.");
        }
    }
}
