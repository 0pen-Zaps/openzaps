// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {RobinhoodV4RouteAdapter} from "../src/adapters/RobinhoodV4RouteAdapter.sol";
import {ZapRangeVault} from "../src/primitives/ZapRangeVault.sol";
import {ZapRangeDepositAdapter} from "../src/adapters/ZapRangeDepositAdapter.sol";
import {ZapRangeWithdrawAdapter} from "../src/adapters/ZapRangeWithdrawAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {SafeApprove} from "../src/libraries/SafeApprove.sol";

/// @dev Read-only window into the v4 PoolManager, used to refuse a dead pool at deploy time.
interface IPoolManagerRead {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title DeployRobinhoodUse
/// @notice Adds the "Use" expansion to the EXISTING, ALREADY-DEPLOYED OpenZap v1.1.0 set on
///         Robinhood Chain (4663) — the contracts that turn the console from one bounded swap into
///         a set of real DeFi actions:
///
///           1. `RobinhoodV4RouteAdapter` x2 — multi-swap stitching. One frozen two-hop route
///              USDG -> aeWETH -> 0xZAPS (and its reverse) through the two deepest live pools for
///              those pairs, executed as ONE zap step. Hop 2 spends the measured output of hop 1
///              at runtime, so nothing is guessed at signing time and nothing strands.
///           2. `ZapRangeVault` — the chain's first ERC-20 LP token: a full-range v4 position on
///              the deepest hookless aeWETH/USDG pool, wrapped as shares. Trading fees compound to
///              holders. Seeded in the same run, seed shares burned.
///           3. `ZapRangeDepositAdapter` — "provide liquidity" as a zap step: ONE currency in,
///              half swapped in-pool, both legs deposited, LP shares straight to the calling zap.
///           4. `ZapRangeWithdrawAdapter` x2 — the unwind leg: shares in, ONE currency out (one
///              instance settles on USDG, one on aeWETH). Without these an LP position is a
///              one-way door only `emergencyExit` could reopen.
///
///      THE ALLOWLIST ENTRY PEOPLE FORGET, again: the vault SHARE TOKEN (the vault address itself)
///      is the deposit step's `tokenOut` AND the withdraw step's `tokenIn`. Without
///      `TokenAllowlist.setToken(vault, true)` every LP step is dead on arrival.
///
/// @dev THIS SCRIPT DEPLOYS NO CORE. Registry, allowlist, factory and implementation already exist
///      on 4663 and are pinned below. Re-running `DeployRobinhood.s.sol` would orphan every live
///      capsule; do not.
///
///      NO KEY MATERIAL. `vm.startBroadcast()` takes no argument: the signer comes from the forge
///      CLI (`--ledger`, `--trezor`, `--account`, `--interactive`) and the deployer address is
///      whatever `--sender` names. `GOVERNANCE` is reporting-only.
///
///      WHO CAN DO WHAT: anyone can deploy the six contracts and fund the seed from their own
///      balance. ONLY the current `AdapterRegistry.owner()` can allowlist the five adapters, and
///      ONLY the current `TokenAllowlist.owner()` can allowlist tokens. The script checks `owner()`
///      live, takes the branch actually available, and prints exact calldata for whatever is left
///      — it never claims a governance call happened when it did not.
///
///      ENVIRONMENT (all optional; defaults are the measured Robinhood Chain values):
///        GOVERNANCE            address  reporting only. Default: live `AdapterRegistry.owner()`.
///        REQUIRE_POOL_LIQUIDITY bool    default true — refuse adapters/vault for dead pools.
///        VAULT_NAME            string   default "OpenZap Range aeWETH/USDG"
///        VAULT_SYMBOL          string   default "ozRANGE"
///        VAULT_SEED_AMOUNT0    uint     default 500000000000000 (0.0005 aeWETH). Deployer-funded.
///        VAULT_SEED_AMOUNT1    uint     default 1000000 (1.000000 USDG). Deployer-funded.
///        VAULT_SEED_RECIPIENT  address  default 0x...dEaD — seed shares are burned by design.
///                                       Setting BOTH seed amounts to 0 skips seeding, prints a
///                                       loud warning, and you own the consequence.
///
///      WHAT THIS SCRIPT REFUSES TO DO:
///        * run on any chain but 4663;
///        * run against a factory that is not v1.1.0 or not wired to the pinned governance;
///        * deploy against pools whose ids do not match the pinned, measured ids;
///        * deploy against a dead pool (unless REQUIRE_POOL_LIQUIDITY=false);
///        * deploy an unseeded vault unless you explicitly zero both seed amounts;
///        * claim a governance call happened when it did not.
contract DeployRobinhoodUse is Script {
    using SafeApprove for address;

    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    // --- live OpenZap v1.1.0 deployment, from src/lib/robinhood.ts ----------------------------- //
    address internal constant ADAPTER_REGISTRY = 0x9E56e444f490C00A6277326A47Cb462E12dF1f17;
    address internal constant TOKEN_ALLOWLIST = 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B;
    address internal constant OPENZAP_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;
    string internal constant EXPECTED_VERSION = "1.1.0";

    // --- Uniswap v4 on Robinhood Chain ---------------------------------------------------------- //
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    // --- tokens --------------------------------------------------------------------------------- //
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // 18dp
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; //  6dp
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07; // 18dp
    address internal constant ZAPS_HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;

    // --- the two measured pools the route and the vault use ------------------------------------- //
    // Hookless static-fee aeWETH/USDG — the deepest live pool for the pair, and the vault's pool.
    uint24 internal constant STATIC_FEE = 450;
    int24 internal constant STATIC_TICK_SPACING = 9;
    bytes32 internal constant STATIC_POOL_ID = 0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2;
    // Hooked dynamic-fee aeWETH/0xZAPS — the production 0xZAPS pool.
    uint24 internal constant DYNAMIC_FEE_FLAG = 0x800000;
    int24 internal constant DYNAMIC_TICK_SPACING = 200;
    bytes32 internal constant DYNAMIC_POOL_ID = 0xb040f18affd851c6ea02b896b2f846cb77edbb33cc5361f7f8c6d14b87c01573;

    /// @dev v4 `StateLibrary.POOLS_SLOT`, and the offset of `Pool.State.liquidity` inside it.
    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant DEFAULT_SEED_AMOUNT0 = 0.0005 ether; // aeWETH
    uint256 internal constant DEFAULT_SEED_AMOUNT1 = 1_000_000; // 1.000000 USDG

    error WrongChain(uint256 actual);
    error MissingCode(address target);
    error ZeroGovernance();
    error UnexpectedCoreVersion(string actual);
    error FactoryNotWiredToPinnedGovernance(address adapters, address tokens);
    error DeadPool(bytes32 poolId);
    error HalfSeed(uint256 amount0, uint256 amount1);
    error UnfundedSeed(address asset, uint256 needed, uint256 held);
    error SeedProducedNoShares();
    error DeploymentAssertionFailed();

    struct Config {
        address deployer;
        address governance;
        bool requireLiquidity;
        string vaultName;
        string vaultSymbol;
        uint256 seedAmount0;
        uint256 seedAmount1;
        address seedRecipient;
    }

    struct Deployed {
        RobinhoodV4RouteAdapter routeUsdgToZaps;
        RobinhoodV4RouteAdapter routeZapsToUsdg;
        ZapRangeVault vault;
        ZapRangeDepositAdapter rangeDeposit;
        ZapRangeWithdrawAdapter rangeWithdrawUsdg;
        ZapRangeWithdrawAdapter rangeWithdrawWeth;
        uint256 seedShares;
    }

    function run() external returns (Deployed memory d) {
        Config memory cfg = _config();

        AdapterRegistry registry = AdapterRegistry(ADAPTER_REGISTRY);
        TokenAllowlist allowlist = TokenAllowlist(TOKEN_ALLOWLIST);

        _preflight(cfg, registry, allowlist);

        address registryOwner = registry.owner();
        address allowlistOwner = allowlist.owner();

        // ---- deploy --------------------------------------------------------------------------- //
        vm.startBroadcast();

        d.routeUsdgToZaps = new RobinhoodV4RouteAdapter(UNIVERSAL_ROUTER, PERMIT2, _forwardPath(), _forwardHops());
        d.routeZapsToUsdg = new RobinhoodV4RouteAdapter(UNIVERSAL_ROUTER, PERMIT2, _reversePath(), _reverseHops());

        d.vault = new ZapRangeVault(
            POOL_MANAGER, AEWETH, USDG, STATIC_FEE, STATIC_TICK_SPACING, cfg.vaultName, cfg.vaultSymbol
        );
        d.rangeDeposit = new ZapRangeDepositAdapter(UNIVERSAL_ROUTER, PERMIT2, address(d.vault));
        d.rangeWithdrawUsdg = new ZapRangeWithdrawAdapter(UNIVERSAL_ROUTER, PERMIT2, address(d.vault), USDG);
        d.rangeWithdrawWeth = new ZapRangeWithdrawAdapter(UNIVERSAL_ROUTER, PERMIT2, address(d.vault), AEWETH);

        // Seed inside the same run, shares burned: closes first-depositor rounding games for good
        // and proves deposit/redeem work against the live pool before anyone else touches it.
        if (cfg.seedAmount0 != 0) {
            AEWETH.approveExact(address(d.vault), cfg.seedAmount0);
            USDG.approveExact(address(d.vault), cfg.seedAmount1);
            (d.seedShares,,) = d.vault.deposit(cfg.seedAmount0, cfg.seedAmount1, 0, cfg.seedRecipient);
            if (d.seedShares == 0) revert SeedProducedNoShares();
            AEWETH.approveExact(address(d.vault), 0);
            USDG.approveExact(address(d.vault), 0);
        }

        // ---- governance wiring, only where the deployer actually has the right ------------------ //
        if (cfg.deployer == registryOwner) {
            registry.setAdapter(address(d.routeUsdgToZaps), true);
            registry.setAdapter(address(d.routeZapsToUsdg), true);
            registry.setAdapter(address(d.rangeDeposit), true);
            registry.setAdapter(address(d.rangeWithdrawUsdg), true);
            registry.setAdapter(address(d.rangeWithdrawWeth), true);
        }
        if (cfg.deployer == allowlistOwner) {
            _allowToken(allowlist, AEWETH);
            _allowToken(allowlist, USDG);
            _allowToken(allowlist, ZAPS);
            // The SHARE TOKEN: deposit tokenOut, withdraw tokenIn, and the outAsset of a
            // provide-liquidity capsule. Without this every LP step is dead on arrival.
            _allowToken(allowlist, address(d.vault));
        }

        vm.stopBroadcast();

        _assertDeployment(d);
        _report(cfg, d, registryOwner, allowlistOwner);
        _reportGovernanceWork(d, registry, allowlist);
    }

    function _allowToken(TokenAllowlist allowlist, address token) internal {
        if (!allowlist.isAllowed(token)) allowlist.setToken(token, true);
    }

    function _assertDeployment(Deployed memory d) internal view {
        // Both route adapters resolve to the two measured pools, in the right order.
        if (
            d.routeUsdgToZaps.poolId(0) != STATIC_POOL_ID || d.routeUsdgToZaps.poolId(1) != DYNAMIC_POOL_ID
                || d.routeZapsToUsdg.poolId(0) != DYNAMIC_POOL_ID || d.routeZapsToUsdg.poolId(1) != STATIC_POOL_ID
                || d.routeUsdgToZaps.hopCount() != 2 || d.routeZapsToUsdg.hopCount() != 2
        ) revert DeploymentAssertionFailed();
        address[] memory forward = d.routeUsdgToZaps.route();
        address[] memory reverse = d.routeZapsToUsdg.route();
        if (forward[0] != USDG || forward[2] != ZAPS || reverse[0] != ZAPS || reverse[2] != USDG) {
            revert DeploymentAssertionFailed();
        }

        // The vault LPs the pinned hookless pool, and every range adapter is welded to THIS vault.
        if (
            d.vault.poolId() != STATIC_POOL_ID || address(d.rangeDeposit.vault()) != address(d.vault)
                || d.rangeDeposit.poolId() != STATIC_POOL_ID || address(d.rangeWithdrawUsdg.vault()) != address(d.vault)
                || d.rangeWithdrawUsdg.assetOut() != USDG || address(d.rangeWithdrawWeth.vault()) != address(d.vault)
                || d.rangeWithdrawWeth.assetOut() != AEWETH
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
        cfg.vaultName = vm.envOr("VAULT_NAME", string("OpenZap Range aeWETH/USDG"));
        cfg.vaultSymbol = vm.envOr("VAULT_SYMBOL", string("ozRANGE"));
        cfg.seedAmount0 = vm.envOr("VAULT_SEED_AMOUNT0", DEFAULT_SEED_AMOUNT0);
        cfg.seedAmount1 = vm.envOr("VAULT_SEED_AMOUNT1", DEFAULT_SEED_AMOUNT1);
        cfg.seedRecipient = vm.envOr("VAULT_SEED_RECIPIENT", DEAD);
    }

    function _preflight(Config memory cfg, AdapterRegistry registry, TokenAllowlist allowlist) internal view {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        _requireCode(ADAPTER_REGISTRY);
        _requireCode(TOKEN_ALLOWLIST);
        _requireCode(OPENZAP_FACTORY);
        _requireCode(UNIVERSAL_ROUTER);
        _requireCode(PERMIT2);
        _requireCode(POOL_MANAGER);
        _requireCode(AEWETH);
        _requireCode(USDG);
        _requireCode(ZAPS);
        _requireCode(ZAPS_HOOK);

        OpenZapFactory factory = OpenZapFactory(OPENZAP_FACTORY);
        if (keccak256(bytes(factory.VERSION())) != keccak256(bytes(EXPECTED_VERSION))) {
            revert UnexpectedCoreVersion(factory.VERSION());
        }
        if (address(factory.adapters()) != ADAPTER_REGISTRY || address(factory.tokens()) != TOKEN_ALLOWLIST) {
            revert FactoryNotWiredToPinnedGovernance(address(factory.adapters()), address(factory.tokens()));
        }
        registry.owner();
        allowlist.owner();

        // Both route pools and the vault pool must be alive. The ids are pinned constants, so a
        // drifted pool definition fails here before anything is deployed.
        if (cfg.requireLiquidity) {
            if (_liquidity(STATIC_POOL_ID) == 0) revert DeadPool(STATIC_POOL_ID);
            if (_liquidity(DYNAMIC_POOL_ID) == 0) revert DeadPool(DYNAMIC_POOL_ID);
        }

        // The seed is both-or-nothing: a range position needs both currencies, and a half seed
        // would deploy a vault that looks seeded and is not.
        if ((cfg.seedAmount0 == 0) != (cfg.seedAmount1 == 0)) revert HalfSeed(cfg.seedAmount0, cfg.seedAmount1);
        if (cfg.seedAmount0 != 0) {
            uint256 held0 = IERC20(AEWETH).balanceOf(cfg.deployer);
            if (held0 < cfg.seedAmount0) revert UnfundedSeed(AEWETH, cfg.seedAmount0, held0);
            uint256 held1 = IERC20(USDG).balanceOf(cfg.deployer);
            if (held1 < cfg.seedAmount1) revert UnfundedSeed(USDG, cfg.seedAmount1, held1);
        }
    }

    function _liquidity(bytes32 poolId) internal view returns (uint128) {
        bytes32 stateSlot = keccak256(abi.encodePacked(poolId, POOLS_SLOT));
        bytes32 word = IPoolManagerRead(POOL_MANAGER).extsload(bytes32(uint256(stateSlot) + LIQUIDITY_OFFSET));
        // casting to 'uint128' is safe: liquidity occupies the low 128 bits of its word.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(uint256(word));
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    // ------------------------------------------------------------------------------------------- //
    // Route definitions (frozen; a different route is a different deployment)                     //
    // ------------------------------------------------------------------------------------------- //

    function _forwardPath() internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = USDG;
        path[1] = AEWETH;
        path[2] = ZAPS;
    }

    function _reversePath() internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = ZAPS;
        path[1] = AEWETH;
        path[2] = USDG;
    }

    function _staticHop() internal pure returns (RobinhoodV4RouteAdapter.PoolKey memory) {
        return RobinhoodV4RouteAdapter.PoolKey({
            currency0: AEWETH, currency1: USDG, fee: STATIC_FEE, tickSpacing: STATIC_TICK_SPACING, hooks: address(0)
        });
    }

    function _dynamicHop() internal pure returns (RobinhoodV4RouteAdapter.PoolKey memory) {
        return RobinhoodV4RouteAdapter.PoolKey({
            currency0: AEWETH,
            currency1: ZAPS,
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: DYNAMIC_TICK_SPACING,
            hooks: ZAPS_HOOK
        });
    }

    function _forwardHops() internal pure returns (RobinhoodV4RouteAdapter.PoolKey[] memory hops) {
        hops = new RobinhoodV4RouteAdapter.PoolKey[](2);
        hops[0] = _staticHop();
        hops[1] = _dynamicHop();
    }

    function _reverseHops() internal pure returns (RobinhoodV4RouteAdapter.PoolKey[] memory hops) {
        hops = new RobinhoodV4RouteAdapter.PoolKey[](2);
        hops[0] = _dynamicHop();
        hops[1] = _staticHop();
    }

    // ------------------------------------------------------------------------------------------- //
    // Reporting                                                                                   //
    // ------------------------------------------------------------------------------------------- //

    function _report(Config memory cfg, Deployed memory d, address registryOwner, address allowlistOwner)
        internal
        view
    {
        console2.log("=== DeployRobinhoodUse ===");
        console2.log("chain id", block.chainid);
        console2.log("block", block.number);
        console2.log("deployer (--sender)", cfg.deployer);
        console2.log("intended governance", cfg.governance);
        console2.log("");
        console2.log("-- existing core, NOT deployed by this script --");
        console2.log("OpenZapFactory", OPENZAP_FACTORY);
        console2.log("AdapterRegistry", ADAPTER_REGISTRY);
        console2.log("  owner", registryOwner);
        console2.log("TokenAllowlist", TOKEN_ALLOWLIST);
        console2.log("  owner", allowlistOwner);
        console2.log("");
        console2.log("-- deployed now --");
        console2.log("RobinhoodV4RouteAdapter USDG->aeWETH->0xZAPS", address(d.routeUsdgToZaps));
        console2.log("  hop 0 poolId (hookless aeWETH/USDG)");
        console2.logBytes32(d.routeUsdgToZaps.poolId(0));
        console2.log("  hop 1 poolId (hooked aeWETH/0xZAPS)");
        console2.logBytes32(d.routeUsdgToZaps.poolId(1));
        console2.log("RobinhoodV4RouteAdapter 0xZAPS->aeWETH->USDG", address(d.routeZapsToUsdg));
        console2.log("ZapRangeVault", address(d.vault));
        console2.log("  pool: hookless aeWETH/USDG 450/9, full range");
        console2.log("  live pool liquidity", uint256(_liquidity(STATIC_POOL_ID)));
        console2.log("  name", d.vault.name());
        console2.log("  symbol", d.vault.symbol());
        console2.log("ZapRangeDepositAdapter", address(d.rangeDeposit));
        console2.log("  tokenIn aeWETH OR USDG; tokenOut is the share token", address(d.vault));
        console2.log("ZapRangeWithdrawAdapter (settles USDG)", address(d.rangeWithdrawUsdg));
        console2.log("ZapRangeWithdrawAdapter (settles aeWETH)", address(d.rangeWithdrawWeth));
        if (cfg.seedAmount0 != 0) {
            console2.log("  seeded aeWETH", cfg.seedAmount0);
            console2.log("  seeded USDG", cfg.seedAmount1);
            console2.log("  seed shares", d.seedShares);
            console2.log("  seed shares sent to (unredeemable by design)", cfg.seedRecipient);
            console2.log("  vault position liquidity", uint256(d.vault.positionLiquidity()));
        } else {
            console2.log("  WARNING: vault deployed UNSEEDED. First-depositor rounding games are");
            console2.log("  mitigated by the virtual offset but not closed. Seed it before");
            console2.log("  advertising it.");
        }
    }

    function _reportGovernanceWork(Deployed memory d, AdapterRegistry registry, TokenAllowlist allowlist)
        internal
        view
    {
        console2.log("");
        console2.log("-- governance --");

        bool fwdLive = registry.isAllowed(address(d.routeUsdgToZaps));
        bool revLive = registry.isAllowed(address(d.routeZapsToUsdg));
        bool depLive = registry.isAllowed(address(d.rangeDeposit));
        bool wUsdgLive = registry.isAllowed(address(d.rangeWithdrawUsdg));
        bool wWethLive = registry.isAllowed(address(d.rangeWithdrawWeth));
        bool wethTok = allowlist.isAllowed(AEWETH);
        bool usdgTok = allowlist.isAllowed(USDG);
        bool zapsTok = allowlist.isAllowed(ZAPS);
        bool shareTok = allowlist.isAllowed(address(d.vault));

        if (fwdLive && revLive && depLive && wUsdgLive && wWethLive && wethTok && usdgTok && zapsTok && shareTok) {
            console2.log("DONE. The deployer owned both governance contracts; every call below was");
            console2.log("executed in this run. Nothing further is required.");
        } else {
            console2.log("ACTION REQUIRED. At least one entry below is still PENDING. Until every");
            console2.log("PENDING call lands, the matching step is not creatable or executable.");
        }

        console2.log("");
        console2.log("registry owner must send to", address(registry));
        _printCall(
            fwdLive,
            "setAdapter(routeUsdgToZaps, true)",
            abi.encodeCall(registry.setAdapter, (address(d.routeUsdgToZaps), true))
        );
        _printCall(
            revLive,
            "setAdapter(routeZapsToUsdg, true)",
            abi.encodeCall(registry.setAdapter, (address(d.routeZapsToUsdg), true))
        );
        _printCall(
            depLive,
            "setAdapter(rangeDepositAdapter, true)",
            abi.encodeCall(registry.setAdapter, (address(d.rangeDeposit), true))
        );
        _printCall(
            wUsdgLive,
            "setAdapter(rangeWithdrawUsdg, true)   <- skip and LP is a one-way door to USDG",
            abi.encodeCall(registry.setAdapter, (address(d.rangeWithdrawUsdg), true))
        );
        _printCall(
            wWethLive,
            "setAdapter(rangeWithdrawWeth, true)   <- skip and LP is a one-way door to aeWETH",
            abi.encodeCall(registry.setAdapter, (address(d.rangeWithdrawWeth), true))
        );

        console2.log("");
        console2.log("allowlist owner must send to", address(allowlist));
        _printCall(wethTok, "setToken(aeWETH, true)", abi.encodeCall(allowlist.setToken, (AEWETH, true)));
        _printCall(usdgTok, "setToken(USDG, true)", abi.encodeCall(allowlist.setToken, (USDG, true)));
        _printCall(zapsTok, "setToken(0xZAPS, true)", abi.encodeCall(allowlist.setToken, (ZAPS, true)));
        _printCall(
            shareTok,
            "setToken(vaultShare, true)   <- REQUIRED: LP-step tokenOut/tokenIn/outAsset",
            abi.encodeCall(allowlist.setToken, (address(d.vault), true))
        );

        console2.log("");
        console2.log("-- what this deployment does NOT give you --");
        console2.log("1. ZapRangeVault is UNAUDITED and custodies real funds; it has strictly more");
        console2.log("   moving parts than ZapVault (real v4 liquidity, fee compounding). Allowlisting");
        console2.log("   the deposit adapter is the moment that custody risk becomes other people's");
        console2.log("   problem. Do not send that call before an independent review.");
        console2.log("2. Full-range LP carries impermanent loss versus holding. The vault does not");
        console2.log("   warn, hedge, or rebalance. Product copy must say this.");
        console2.log("3. A provide-liquidity step refunds the unabsorbed half-swap remainder to the");
        console2.log("   CAPSULE, where it strands until emergencyExit. Small by construction, not zero.");
        console2.log("4. Withdraw belongs in a capsule FUNDED WITH SHARES. Provide-then-withdraw in");
        console2.log("   one capsule cannot settle (delta-based settlement nets to ~zero).");
        console2.log("5. The route adapters freeze ONE route each. A different route is a different");
        console2.log("   deployment, deliberately (I-SURF-1).");
        console2.log("");
        console2.log("-- frontend configuration (src/lib/chains.ts) --");
        console2.log("Set these LAST, after the matching allowlist calls above have landed. An entry");
        console2.log("that drifts from the contract it names is how a user signs a policy that does");
        console2.log("something other than what the block said. Unset values fail CLOSED.");
        console2.log("");
        console2.log("NEXT_PUBLIC_OPENZAP_ROUTE_USDG_ZAPS_ADAPTER", address(d.routeUsdgToZaps));
        console2.log("NEXT_PUBLIC_OPENZAP_ROUTE_ZAPS_USDG_ADAPTER", address(d.routeZapsToUsdg));
        console2.log("NEXT_PUBLIC_OPENZAP_RANGE_VAULT", address(d.vault));
        console2.log("NEXT_PUBLIC_OPENZAP_RANGE_DEPOSIT_ADAPTER", address(d.rangeDeposit));
        console2.log("NEXT_PUBLIC_OPENZAP_RANGE_WITHDRAW_USDG_ADAPTER", address(d.rangeWithdrawUsdg));
        console2.log("NEXT_PUBLIC_OPENZAP_RANGE_WITHDRAW_WETH_ADAPTER", address(d.rangeWithdrawWeth));
    }

    function _printCall(bool satisfied, string memory label, bytes memory data) internal pure {
        console2.log(satisfied ? "  [satisfied on chain]" : "  [PENDING - owner must send]", label);
        console2.log("    calldata");
        console2.logBytes(data);
    }
}
