// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

// --- core (v1.1) --------------------------------------------------------------------------------- //
import {OpenZap} from "../src/OpenZap.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";

// --- Robinhood Chain adapters + the vault primitive ---------------------------------------------- //
import {RobinhoodV4PoolAdapter} from "../src/adapters/RobinhoodV4PoolAdapter.sol";
import {ZapVault} from "../src/primitives/ZapVault.sol";
import {ZapVaultDepositAdapter} from "../src/adapters/ZapVaultDepositAdapter.sol";
import {ZapVaultRedeemAdapter} from "../src/adapters/ZapVaultRedeemAdapter.sol";

// --- Base adapters ------------------------------------------------------------------------------- //
import {BaseV3SwapAdapter} from "../src/adapters/BaseV3SwapAdapter.sol";
import {AaveV3SupplyAdapter} from "../src/adapters/AaveV3SupplyAdapter.sol";
// Track B has shipped src/adapters/AaveV3WithdrawAdapter.sol, so the Base branch deploys the supply
//   adapter's mirror: aToken in, underlying out. Its `tokenIn` is aWETH and `tokenOut` is WETH, both
//   already allowlisted by the supply leg, so it needs no new TokenAllowlist entry. If this import ever
//   fails to compile because Track B's file is mid-edit, comment out this import and the marked
//   withdraw block in `_runBase()` — the swap + supply set does not depend on it.
import {AaveV3WithdrawAdapter} from "../src/adapters/AaveV3WithdrawAdapter.sol";

// Track A / v2 candidate: src/v2/OpenZapFactoryV2.sol HAS shipped (VERSION "2.0.0-candidate"), so it is
//   imported and wired behind the OFF-by-default `DEPLOY_V2_CANDIDATE` flag below. It is UNAUDITED. When
//   the flag is set it is deployed to a fresh, isolated address, pointed at the same
//   registry/allowlist as the production core for READ-ONLY allowlist checks only, and is NEVER
//   transferred governance, funded, or pointed at by the frontend by this script. See
//   `_maybeDeployV2Candidate`. If this import ever fails to compile because Track A's subtree is
//   mid-edit, the correct temporary fix is to comment out this import + the flag branch body and let
//   the branch fall back to warn-only — the production Base/Robinhood sets do not depend on it.
import {OpenZapFactoryV2} from "../src/v2/OpenZapFactoryV2.sol";

import {IERC20} from "../src/interfaces/IERC20.sol";
import {SafeApprove} from "../src/libraries/SafeApprove.sol";

/// @dev Read-only window into the v4 PoolManager, used to refuse a dead pool BEFORE broadcasting.
interface IPoolManagerRead {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @dev Minimal read view of SwapRouter02, to check the router's own factory without importing the
///      adapter's internal interface. Read-only; never used to route anything.
interface IUniswapV3SwapRouter02Minimal {
    function factory() external view returns (address);
}

/// @title DeployEverything
/// @notice THE ONE comprehensive, chain-aware OpenZap deploy script. It reads `block.chainid` and
///         deploys the correct full set for that chain — nothing more, nothing less — matching the
///         keyless style of `DeployBase.s.sol` and `DeployRobinhoodExpansion.s.sol` exactly.
///
///         ┌────────────────────────────────────────────────────────────────────────────────────┐
///         │ Robinhood Chain (4663): ADDS to the ALREADY-LIVE v1.1 core. Does NOT redeploy the     │
///         │   factory/registry/allowlist/implementation — those exist on chain and are pinned as   │
///         │   constants below. Deploys: a `RobinhoodV4PoolAdapter` for the deepest live hookless   │
///         │   aeWETH/USDG pool, a `ZapVault` (seeded in-run by default), and the vault deposit +    │
///         │   redeem adapters. Allowlists every new adapter and every token they touch (USDG and    │
///         │   the vault share), where the deployer has the right; otherwise prints the exact        │
///         │   governance calldata as PENDING. Prints the frontend env vars for src/lib/chains.ts.   │
///         │                                                                                          │
///         │ Base (8453): deploys a FULL FRESH v1.1 core (implementation via the factory ctor,        │
///         │   registry, allowlist), then `BaseV3SwapAdapter` and `AaveV3SupplyAdapter` (and          │
///         │   `AaveV3WithdrawAdapter` IF Track B shipped it — see the import note above). Allowlists  │
///         │   the adapters and their tokens, then PROPOSES ownership of registry + allowlist to       │
///         │   GOVERNANCE (two-step; the Safe must still `acceptOwnership()`).                          │
///         │                                                                                          │
///         │ v2 candidate (BOTH chains, OFF by default): only when `DEPLOY_V2_CANDIDATE=true` AND      │
///         │   Track A has shipped src/v2/OpenZapFactoryV2.sol does anything happen. It is UNAUDITED   │
///         │   and must not custody funds without review. Absent the file, the branch does nothing but │
///         │   say why.                                                                                 │
///         └────────────────────────────────────────────────────────────────────────────────────┘
///
/// @dev NOT IDEMPOTENT — READ THIS BEFORE RE-RUNNING.
///      This script is safe to *simulate* any number of times (no `--broadcast`). BROADCASTING it a
///      second time is dangerous and it cannot fully stop you:
///        * On Base every run stands up a NEW, disconnected core (new registry/allowlist/factory/impl)
///          and new adapters. A second broadcast does not converge on the first; it produces a second
///          deployment whose zaps are invisible to the first one's governance. Run it exactly ONCE per
///          environment and record what it prints. To add one adapter later, deploy that adapter alone
///          and have governance call `setAdapter` — do NOT re-run this.
///        * On Robinhood every run deploys a NEW pool adapter + a NEW vault (+ its two adapters) at
///          fresh CREATE addresses derived from the deployer nonce, and — if the deployer owns
///          governance — allowlists that new vault share. A second broadcast therefore orphans the
///          first vault and its adapters. There is no on-chain "have I already run" flag to guard on,
///          so idempotency is the operator's responsibility; the fail-closed preflights below
///          (UnfundedSeed, DeadPool, UnexpectedPoolId, version/wiring checks) are the only automatic
///          brakes, and they guard correctness, not re-run.
///
///      NO KEY MATERIAL. `vm.startBroadcast()` takes no argument, so the signer comes from the forge
///      CLI (`--ledger`, `--trezor`, `--account`, `--interactive`, or an external signer) and the
///      deployer is whatever `--sender` names. This script never reads, writes or requests a private
///      key. `GOVERNANCE` is an ADDRESS used for a two-step ownership PROPOSAL (Base) or for reporting
///      only (Robinhood, where this script does not own the governance contracts and cannot transfer
///      them).
///
///      EVERY external address gets a `_requireCode` check before it is used, and every branch ends in
///      post-deploy assertions that REVERT rather than leave a half-wired deployment on chain.
///
///      ENVIRONMENT (all optional):
///        GOVERNANCE            address  Base: the Safe that will own registry+allowlist (proposed,
///                                       must accept). Robinhood: reporting only; defaults to the live
///                                       AdapterRegistry.owner().
///        DEPLOY_V2_CANDIDATE   bool     default false. See the v2 note above.
///        VAULT_SEED_ASSETS     uint     Robinhood only. default 1_000_000 (1.000000 USDG, 6dp). The
///                                       deployer must already hold this or the run aborts with
///                                       UnfundedSeed in preflight. Set 0 to skip seeding (loud warning;
///                                       you own the grief risk).
///        VAULT_SEED_RECIPIENT  address  Robinhood only. default 0x…dEaD. Seed shares go here and are
///                                       meant to be unredeemable forever, which is what makes the
///                                       price floor permanent.
///
///      For a DIFFERENT Robinhood pool/vault asset than the proven aeWETH/USDG defaults, use the fully
///      parameterized `DeployRobinhoodExpansion.s.sol` instead — this script pins the canonical set on
///      purpose, so the two rows in src/lib/chains.ts (USDG / ozUSDG) cannot silently drift.
contract DeployEverything is Script {
    using SafeApprove for address;

    // =========================================================================================== //
    // Shared                                                                                       //
    // =========================================================================================== //

    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 internal constant BASE_CHAIN_ID = 8453;
    string internal constant EXPECTED_VERSION = "1.1.0";

    /// @dev Standard burn sink. `ZapVault` refuses `address(0)` as a receiver, so seed shares go here.
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // =========================================================================================== //
    // Robinhood Chain (4663) — LIVE core, pinned from src/lib/robinhood.ts. NOT deployed here.     //
    // =========================================================================================== //

    address internal constant RH_ADAPTER_REGISTRY = 0x9E56e444f490C00A6277326A47Cb462E12dF1f17;
    address internal constant RH_TOKEN_ALLOWLIST = 0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B;
    address internal constant RH_OPENZAP_FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;

    // Uniswap v4 infra on Robinhood Chain.
    address internal constant RH_UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant RH_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    // Deep currencies.
    address internal constant RH_AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // 18dp, symbol WETH
    address internal constant RH_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; //  6dp

    // The default pool: the deepest LIVE hookless aeWETH/USDG pool (fee 450, tick 9, hookless).
    uint24 internal constant RH_FEE = 450;
    int24 internal constant RH_TICK_SPACING = 9;
    address internal constant RH_HOOKS = address(0);
    bytes32 internal constant RH_EXPECTED_POOL_ID = 0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2;

    // v4 `StateLibrary.POOLS_SLOT` and the offset of `Pool.State.liquidity` inside it.
    uint256 internal constant RH_POOLS_SLOT = 6;
    uint256 internal constant RH_LIQUIDITY_OFFSET = 3;

    // Vault, pinned to match the two rows in src/lib/chains.ts (USDG / ozUSDG) exactly.
    string internal constant RH_VAULT_NAME = "OpenZap USDG Vault";
    string internal constant RH_VAULT_SYMBOL = "ozUSDG";
    uint256 internal constant RH_DEFAULT_SEED_ASSETS = 1_000_000; // 1.000000 USDG

    // =========================================================================================== //
    // Base (8453) — a FULL FRESH v1.1 core is deployed here.                                       //
    // =========================================================================================== //

    /// @dev The superseded v1.0.0 factory on Base. Recorded so nobody mistakes it for current; this
    ///      script never reads or writes it. OpenZap has no upgrade path (I-ISO-2) — a new core version
    ///      is always a new deployment.
    address internal constant BASE_STALE_V1_0_0_FACTORY = 0xc7C5897e4738a157731c2F93b1d73Db9926E926C;

    address internal constant BASE_SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant BASE_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant BASE_AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @dev 0.05% tier. WETH sorts strictly below USDC on Base (adapter ctor requires tokenA < tokenB).
    uint24 internal constant BASE_FEE_500 = 500;
    /// @dev The pool the swap adapter must resolve to, from the router's own factory.
    address internal constant BASE_EXPECTED_WETH_USDC_500_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;

    // =========================================================================================== //
    // Errors                                                                                       //
    // =========================================================================================== //

    error UnsupportedChain(uint256 chainId);
    error MissingCode(address target);
    error ZeroGovernance();
    error UnexpectedCoreVersion(string actual);
    error FactoryNotWiredToPinnedGovernance(address adapters, address tokens);
    error UnexpectedPoolId(bytes32 expected, bytes32 actual);
    error DeadPool(bytes32 poolId);
    error UnfundedSeed(address asset, uint256 needed, uint256 held);
    error SeedProducedNoShares();
    error UnexpectedRouterFactory(address actual);
    error DeploymentAssertionFailed();

    // =========================================================================================== //
    // Entry point — chain-aware dispatch                                                           //
    // =========================================================================================== //

    function run() external {
        uint256 id = block.chainid;
        if (id == ROBINHOOD_CHAIN_ID) {
            _runRobinhood();
        } else if (id == BASE_CHAIN_ID) {
            _runBase();
        } else {
            revert UnsupportedChain(id);
        }
    }

    // =========================================================================================== //
    // Robinhood Chain (4663) — add to the live core                                                //
    // =========================================================================================== //

    struct RhConfig {
        address deployer;
        address governance; // reporting only on Robinhood
        uint256 seedAssets;
        address seedRecipient;
        bool deployV2Candidate;
    }

    struct RhDeployed {
        RobinhoodV4PoolAdapter poolAdapter;
        ZapVault vault;
        ZapVaultDepositAdapter depositAdapter;
        ZapVaultRedeemAdapter redeemAdapter;
        uint256 seedShares;
    }

    function _runRobinhood() internal {
        RhConfig memory cfg = _rhConfig();
        AdapterRegistry registry = AdapterRegistry(RH_ADAPTER_REGISTRY);
        TokenAllowlist allowlist = TokenAllowlist(RH_TOKEN_ALLOWLIST);

        _rhPreflight(cfg, registry, allowlist);

        address registryOwner = registry.owner();
        address allowlistOwner = allowlist.owner();
        bool ownsRegistry = cfg.deployer == registryOwner;
        bool ownsAllowlist = cfg.deployer == allowlistOwner;

        RhDeployed memory d;

        // ---- deploy ---------------------------------------------------------------------------- //
        vm.startBroadcast();

        d.poolAdapter = new RobinhoodV4PoolAdapter(
            RH_UNIVERSAL_ROUTER, RH_PERMIT2, RH_AEWETH, RH_USDG, RH_FEE, RH_TICK_SPACING, RH_HOOKS
        );

        d.vault = new ZapVault(RH_USDG, RH_VAULT_NAME, RH_VAULT_SYMBOL);
        // Both vault adapters read `asset()` off the vault in their own constructors, so a vault/asset
        // mismatch cannot be introduced here, and both carry the same 4663 chain guard.
        d.depositAdapter = new ZapVaultDepositAdapter(address(d.vault));
        d.redeemAdapter = new ZapVaultRedeemAdapter(address(d.vault));

        // Seed in the same run so the empty-vault donation grief is closed before anyone else can reach
        // it (a donation of X into an empty vault sets a price floor of X/1000 and makes smaller
        // deposits revert). Seed shares are burned to make the floor permanent.
        if (cfg.seedAssets != 0) {
            RH_USDG.approveExact(address(d.vault), cfg.seedAssets);
            d.seedShares = d.vault.deposit(cfg.seedAssets, cfg.seedRecipient);
            if (d.seedShares == 0) revert SeedProducedNoShares();
            RH_USDG.approveExact(address(d.vault), 0); // leave no standing approval behind
        }

        // ---- governance wiring, only where the deployer actually holds the right ---------------- //
        if (ownsRegistry) {
            registry.setAdapter(address(d.poolAdapter), true);
            registry.setAdapter(address(d.depositAdapter), true);
            registry.setAdapter(address(d.redeemAdapter), true);
        }
        if (ownsAllowlist) {
            _rhAllow(allowlist, RH_AEWETH); // pool currency0 (already allowed on chain today)
            _rhAllow(allowlist, RH_USDG); // pool currency1 AND the vault's underlying asset
            _rhAllow(allowlist, address(d.vault)); // the SHARE TOKEN: deposit tokenOut / redeem tokenIn
        }

        // v2 candidate (off unless DEPLOY_V2_CANDIDATE=true). Placed inside the broadcast so it deploys
        // under the same signer. Points at the LIVE registry/allowlist for read-only allowlist checks.
        OpenZapFactoryV2 v2 = _maybeDeployV2Candidate(cfg.deployV2Candidate, registry, allowlist);

        vm.stopBroadcast();

        _rhAssert(d, registry, allowlist, ownsRegistry, ownsAllowlist);
        if (address(v2) != address(0)) _assertV2(v2, registry, allowlist);
        _rhReport(cfg, d, registryOwner, allowlistOwner);
        _rhReportGovernance(cfg, d, registry, allowlist, ownsRegistry, ownsAllowlist);
        _reportV2Candidate(cfg.deployV2Candidate, v2);
    }

    function _rhConfig() internal view returns (RhConfig memory cfg) {
        cfg.deployer = msg.sender; // from --sender; never a key in here
        cfg.governance = vm.envOr("GOVERNANCE", AdapterRegistry(RH_ADAPTER_REGISTRY).owner());
        if (cfg.governance == address(0)) revert ZeroGovernance();
        cfg.seedAssets = vm.envOr("VAULT_SEED_ASSETS", RH_DEFAULT_SEED_ASSETS);
        cfg.seedRecipient = vm.envOr("VAULT_SEED_RECIPIENT", DEAD);
        cfg.deployV2Candidate = vm.envOr("DEPLOY_V2_CANDIDATE", false);
    }

    function _rhPreflight(RhConfig memory cfg, AdapterRegistry registry, TokenAllowlist allowlist) internal view {
        // Chain guard is implicit (dispatch), but re-assert it so this function is safe in isolation.
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert UnsupportedChain(block.chainid);

        _requireCode(RH_ADAPTER_REGISTRY);
        _requireCode(RH_TOKEN_ALLOWLIST);
        _requireCode(RH_OPENZAP_FACTORY);
        _requireCode(RH_UNIVERSAL_ROUTER);
        _requireCode(RH_PERMIT2);
        _requireCode(RH_POOL_MANAGER);
        _requireCode(RH_AEWETH);
        _requireCode(RH_USDG);

        // The live core must be the one we think it is. A factory pointing at a different registry means
        // allowlisting here would not affect the capsules people actually create.
        OpenZapFactory factory = OpenZapFactory(RH_OPENZAP_FACTORY);
        if (keccak256(bytes(factory.VERSION())) != keccak256(bytes(EXPECTED_VERSION))) {
            revert UnexpectedCoreVersion(factory.VERSION());
        }
        if (address(factory.adapters()) != RH_ADAPTER_REGISTRY || address(factory.tokens()) != RH_TOKEN_ALLOWLIST) {
            revert FactoryNotWiredToPinnedGovernance(address(factory.adapters()), address(factory.tokens()));
        }
        // Touch both so a swapped-out governance contract fails here rather than mid-run.
        registry.owner();
        allowlist.owner();

        // The pool must be the one named, and it must be alive. Checking here means a mistyped pool
        // field costs nothing instead of costing a deployment.
        bytes32 poolId = keccak256(abi.encode(RH_AEWETH, RH_USDG, RH_FEE, RH_TICK_SPACING, RH_HOOKS));
        if (poolId != RH_EXPECTED_POOL_ID) revert UnexpectedPoolId(RH_EXPECTED_POOL_ID, poolId);
        if (_rhLiquidity(poolId) == 0) revert DeadPool(poolId);

        // Seeding is funded from the deployer's own balance. Fail here, before any deployment.
        if (cfg.seedAssets != 0) {
            uint256 held = IERC20(RH_USDG).balanceOf(cfg.deployer);
            if (held < cfg.seedAssets) revert UnfundedSeed(RH_USDG, cfg.seedAssets, held);
        }
    }

    /// @dev `setToken` is idempotent, but reading first keeps the broadcast free of no-op writes and
    ///      makes the USDG-appears-twice dedupe (pool currency1 == vault asset) automatic.
    function _rhAllow(TokenAllowlist allowlist, address token) internal {
        if (!allowlist.isAllowed(token)) allowlist.setToken(token, true);
    }

    /// @dev Live `liquidity` for a pool, read straight out of the PoolManager's state.
    function _rhLiquidity(bytes32 poolId) internal view returns (uint128) {
        bytes32 stateSlot = keccak256(abi.encodePacked(poolId, RH_POOLS_SLOT));
        bytes32 word = IPoolManagerRead(RH_POOL_MANAGER).extsload(bytes32(uint256(stateSlot) + RH_LIQUIDITY_OFFSET));
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(uint256(word));
    }

    function _rhAssert(
        RhDeployed memory d,
        AdapterRegistry registry,
        TokenAllowlist allowlist,
        bool ownsRegistry,
        bool ownsAllowlist
    ) internal view {
        // The pool adapter is wired to the pool that was named.
        if (
            d.poolAdapter.poolId() != RH_EXPECTED_POOL_ID || d.poolAdapter.universalRouter() != RH_UNIVERSAL_ROUTER
                || d.poolAdapter.permit2() != RH_PERMIT2 || d.poolAdapter.currency0() != RH_AEWETH
                || d.poolAdapter.currency1() != RH_USDG || d.poolAdapter.fee() != RH_FEE
                || d.poolAdapter.tickSpacing() != RH_TICK_SPACING || d.poolAdapter.hooks() != RH_HOOKS
        ) revert DeploymentAssertionFailed();

        // The vault is the vault that was asked for, and the seed landed if one was requested.
        if (
            d.vault.asset() != RH_USDG || address(d.vault).code.length == 0
                || (d.seedShares != 0 && (d.vault.totalSupply() != d.seedShares))
        ) revert DeploymentAssertionFailed();

        // Both vault adapters point at THIS vault and agree with it about the underlying asset.
        if (
            d.depositAdapter.vault() != address(d.vault) || d.depositAdapter.asset() != RH_USDG
                || d.redeemAdapter.vault() != address(d.vault) || d.redeemAdapter.asset() != RH_USDG
        ) revert DeploymentAssertionFailed();

        // Governance only where it was actually exercised — never assert a call we skipped.
        if (ownsRegistry) {
            if (
                !registry.isAllowed(address(d.poolAdapter)) || !registry.isAllowed(address(d.depositAdapter))
                    || !registry.isAllowed(address(d.redeemAdapter))
            ) revert DeploymentAssertionFailed();
        }
        if (ownsAllowlist) {
            if (
                !allowlist.isAllowed(RH_AEWETH) || !allowlist.isAllowed(RH_USDG)
                    || !allowlist.isAllowed(address(d.vault))
            ) revert DeploymentAssertionFailed();
        }
    }

    function _rhReport(RhConfig memory cfg, RhDeployed memory d, address registryOwner, address allowlistOwner)
        internal
        view
    {
        console2.log("=== DeployEverything : Robinhood Chain (4663) ===");
        console2.log("chain id", block.chainid);
        console2.log("block", block.number);
        console2.log("deployer (--sender)", cfg.deployer);
        console2.log("intended governance (reporting only)", cfg.governance);
        console2.log("");
        console2.log("-- existing core, NOT deployed by this script --");
        console2.log("OpenZapFactory", RH_OPENZAP_FACTORY);
        console2.log("AdapterRegistry", RH_ADAPTER_REGISTRY);
        console2.log("  owner", registryOwner);
        console2.log("  pendingOwner", AdapterRegistry(RH_ADAPTER_REGISTRY).pendingOwner());
        console2.log("TokenAllowlist", RH_TOKEN_ALLOWLIST);
        console2.log("  owner", allowlistOwner);
        console2.log("  pendingOwner", TokenAllowlist(RH_TOKEN_ALLOWLIST).pendingOwner());
        console2.log("");
        console2.log("-- deployed now --");
        console2.log("RobinhoodV4PoolAdapter (aeWETH/USDG)", address(d.poolAdapter));
        console2.log("  poolId");
        console2.logBytes32(d.poolAdapter.poolId());
        console2.log("  live pool liquidity", uint256(_rhLiquidity(d.poolAdapter.poolId())));
        console2.log("ZapVault", address(d.vault));
        console2.log("  asset", d.vault.asset());
        console2.log("  symbol", d.vault.symbol());
        console2.log("  share decimals", uint256(d.vault.decimals()));
        console2.log("ZapVaultDepositAdapter", address(d.depositAdapter));
        console2.log("ZapVaultRedeemAdapter", address(d.redeemAdapter));
        if (cfg.seedAssets != 0) {
            console2.log("  seeded assets (USDG)", cfg.seedAssets);
            console2.log("  seed shares", d.seedShares);
            console2.log("  seed shares sent to (unredeemable by design)", cfg.seedRecipient);
        } else {
            console2.log("  WARNING: vault deployed UNSEEDED. An empty ZapVault is grief-able: a");
            console2.log("  donation of X before the first deposit sets a price floor of X/1000 per");
            console2.log("  share and makes smaller deposits revert. Seed it before advertising it.");
        }
    }

    function _rhReportGovernance(
        RhConfig memory cfg,
        RhDeployed memory d,
        AdapterRegistry registry,
        TokenAllowlist allowlist,
        bool ownsRegistry,
        bool ownsAllowlist
    ) internal view {
        console2.log("");
        console2.log("-- governance --");

        address vault = address(d.vault);
        bool poolLive = registry.isAllowed(address(d.poolAdapter));
        bool depositLive = registry.isAllowed(address(d.depositAdapter));
        bool redeemLive = registry.isAllowed(address(d.redeemAdapter));
        bool aewethLive = allowlist.isAllowed(RH_AEWETH);
        bool usdgLive = allowlist.isAllowed(RH_USDG);
        bool shareLive = allowlist.isAllowed(vault);

        if (poolLive && depositLive && redeemLive && aewethLive && usdgLive && shareLive) {
            console2.log("DONE. The deployer owned both governance contracts, so every call below was");
            console2.log("executed in this run. Nothing further is required.");
        } else {
            console2.log("ACTION REQUIRED. At least one entry below is still PENDING, because the");
            console2.log("deployer is not the owner of the governance contract it belongs to. Until");
            console2.log("every PENDING call lands, the new adapters are not callable from any zap and");
            console2.log("the vault share token cannot be a step input, a step output, or an outAsset.");
        }
        // Belt-and-braces: `ownsRegistry`/`ownsAllowlist` decide whether this run *attempted* the
        // writes; the live reads above decide whether they *stuck*. Log the intent for the record.
        console2.log("  deployer owns AdapterRegistry", ownsRegistry);
        console2.log("  deployer owns TokenAllowlist", ownsAllowlist);

        console2.log("");
        console2.log("registry owner must send to", address(registry));
        _printCall(
            poolLive,
            "AdapterRegistry.setAdapter(poolAdapter, true)",
            abi.encodeCall(registry.setAdapter, (address(d.poolAdapter), true))
        );
        _printCall(
            depositLive,
            "AdapterRegistry.setAdapter(vaultDepositAdapter, true)",
            abi.encodeCall(registry.setAdapter, (address(d.depositAdapter), true))
        );
        _printCall(
            redeemLive,
            "AdapterRegistry.setAdapter(vaultRedeemAdapter, true)",
            abi.encodeCall(registry.setAdapter, (address(d.redeemAdapter), true))
        );

        console2.log("");
        console2.log("allowlist owner must send to", address(allowlist));
        _printCall(
            aewethLive,
            "TokenAllowlist.setToken(aeWETH, true)   <- pool currency0 (already allowed today)",
            abi.encodeCall(allowlist.setToken, (RH_AEWETH, true))
        );
        _printCall(
            usdgLive,
            "TokenAllowlist.setToken(USDG, true)     <- pool currency1 / deposit tokenIn / redeem tokenOut",
            abi.encodeCall(allowlist.setToken, (RH_USDG, true))
        );
        _printCall(
            shareLive,
            "TokenAllowlist.setToken(vaultShare, true) <- REQUIRED: deposit tokenOut / redeem tokenIn",
            abi.encodeCall(allowlist.setToken, (vault, true))
        );

        address registryPending = registry.pendingOwner();
        address allowlistPending = allowlist.pendingOwner();
        if (registryPending != address(0) || allowlistPending != address(0)) {
            console2.log("");
            console2.log("NOTE: an ownership handoff is proposed and NOT accepted. The CURRENT owner is");
            console2.log("still the one that must send the calls above.");
            if (registryPending != address(0)) {
                console2.log("  AdapterRegistry pendingOwner must call acceptOwnership()", registryPending);
            }
            if (allowlistPending != address(0)) {
                console2.log("  TokenAllowlist pendingOwner must call acceptOwnership()", allowlistPending);
            }
        }

        console2.log("");
        console2.log("-- what this deployment does NOT give you --");
        console2.log("1. ZapVault is UNAUDITED and custodies real funds. It earns nothing:");
        console2.log("   totalAssets() is asset.balanceOf(vault). Do not present it as yield.");
        console2.log("2. A deposit-then-redeem round trip in ONE capsule cannot settle (settlement");
        console2.log("   measures balanceOf(outAsset) after minus before). Redeem belongs in a capsule");
        console2.log("   FUNDED WITH SHARES.");
        console2.log("3. Step.amountIn is frozen at signing; a redeem step cannot consume whatever a");
        console2.log("   deposit step minted. Surplus strands until the owner calls emergencyExit.");
        console2.log("4. The builder cannot draw a supply/redeem chain yet -- front-end catalogue work,");
        console2.log("   not a contract gap. See BASE_CAPABILITIES.md section 4b.");
        console2.log("");
        console2.log("-- frontend configuration (src/lib/chains.ts) --");
        console2.log("Set these LAST, only AFTER the adapters are allowlisted above. An unset or");
        console2.log("malformed value fails CLOSED: the step is treated as undeployed.");
        console2.log("NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_USDG_ADAPTER", address(d.poolAdapter));
        console2.log("NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER", address(d.depositAdapter));
        console2.log("NEXT_PUBLIC_OPENZAP_ZAP_VAULT_REDEEM_ADAPTER", address(d.redeemAdapter));
        // The three console lines below are STALE as of PR #23: the catalogue now names USDG and the
        // ZapVault venue, so setting these env vars DOES make a swap-then-deposit chain drawable. The
        // text is left byte-exact because _runRobinhood sits on via_ir's stack-depth limit and any edit
        // here fails to compile; FINAL_DEPLOYMENT.md carries the correct, current guidance.
        console2.log("NOTE: setting the two vault vars alone changes NOTHING a user can draw. The");
        console2.log("catalogue in src/lib/blocks.ts offers no USDG asset and no ZapVault market, so no");
        console2.log("drawn chain selects these. Making a vault step reachable is a separate, deliberate");
        console2.log("catalogue change -- and the one that must carry honest copy for an unaudited,");
        console2.log("non-yield-bearing vault.");
    }

    // =========================================================================================== //
    // Base (8453) — fresh v1.1 core                                                                //
    // =========================================================================================== //

    function _runBase() internal {
        // ---- preflight: refuse anything but Base, against anything but real code ---------------- //
        if (block.chainid != BASE_CHAIN_ID) revert UnsupportedChain(block.chainid);
        _requireCode(BASE_SWAP_ROUTER_02);
        _requireCode(BASE_V3_FACTORY);
        _requireCode(BASE_AAVE_V3_POOL);
        _requireCode(BASE_WETH);
        _requireCode(BASE_USDC);
        _requireCode(BASE_EXPECTED_WETH_USDC_500_POOL);

        // The router must be wired to the factory we think it is; the swap adapter resolves its pool
        // through `swapRouter.factory()`, so a different factory silently means a different pool.
        address routerFactory = IUniswapV3SwapRouter02Minimal(BASE_SWAP_ROUTER_02).factory();
        if (routerFactory != BASE_V3_FACTORY) revert UnexpectedRouterFactory(routerFactory);

        address deployer = msg.sender; // from --sender; never a key in here
        address governance = vm.envOr("GOVERNANCE", deployer);
        if (governance == address(0)) revert ZeroGovernance();
        bool deployV2Candidate = vm.envOr("DEPLOY_V2_CANDIDATE", false);

        // ---- deploy ----------------------------------------------------------------------------- //
        vm.startBroadcast();

        // Governance first, owned by the deployer for the duration of this script only.
        AdapterRegistry registry = new AdapterRegistry(deployer);
        TokenAllowlist allowlist = new TokenAllowlist(deployer);

        // The factory deploys the OpenZap implementation in its own constructor and pins itself as that
        // implementation's sole initializer.
        OpenZapFactory factory = new OpenZapFactory(registry, allowlist);

        // Adapters. One instance == one pool / one reserve == one action (I-SURF-1). Both constructors
        // do their own on-chain verification and revert rather than mis-wire.
        BaseV3SwapAdapter swapAdapter = new BaseV3SwapAdapter(BASE_SWAP_ROUTER_02, BASE_WETH, BASE_USDC, BASE_FEE_500);
        AaveV3SupplyAdapter supplyAdapter = new AaveV3SupplyAdapter(BASE_AAVE_V3_POOL, BASE_WETH);

        registry.setAdapter(address(swapAdapter), true);
        registry.setAdapter(address(supplyAdapter), true);

        // Tokens. WETH and USDC are the swap pair and the supply reserve. aWETH must be allowlisted too
        // or `execute` rejects the supply step's own output (the aToken) with InvalidAdapterResult.
        address aWETH = supplyAdapter.aToken();
        allowlist.setToken(BASE_WETH, true);
        allowlist.setToken(BASE_USDC, true);
        allowlist.setToken(aWETH, true);

        // AaveV3WithdrawAdapter (Track B, shipped): the supply leg's mirror. Its `tokenIn` is aWETH and
        // its `tokenOut` is WETH, both already allowlisted above, so it needs no new TokenAllowlist
        // entry — only a registry entry. Its constructor resolves the aToken from the Pool and requires
        // it to match aWETH, so a mis-wire reverts at construction.
        AaveV3WithdrawAdapter withdrawAdapter = new AaveV3WithdrawAdapter(BASE_AAVE_V3_POOL, BASE_WETH);
        registry.setAdapter(address(withdrawAdapter), true);

        // v2 candidate (off unless DEPLOY_V2_CANDIDATE=true). Points at THIS run's fresh
        // registry/allowlist for read-only allowlist checks. Deployed before the ownership proposal;
        // it needs no ownership of its own.
        OpenZapFactoryV2 v2 = _maybeDeployV2Candidate(deployV2Candidate, registry, allowlist);

        // Two-step handoff: propose only. Governance still has to accept, on both contracts.
        if (governance != deployer) {
            registry.transferOwnership(governance);
            allowlist.transferOwnership(governance);
        }

        vm.stopBroadcast();

        // ---- post-deploy assertions: fail the run rather than print a half-wired deployment ----- //
        if (keccak256(bytes(factory.VERSION())) != keccak256(bytes(EXPECTED_VERSION))) {
            revert UnexpectedCoreVersion(factory.VERSION());
        }
        if (
            address(factory.adapters()) != address(registry) || address(factory.tokens()) != address(allowlist)
                || factory.implementation().code.length == 0
                // I-ISO-1: the shared implementation is bricked at construction and can never be owned.
                || OpenZap(payable(factory.implementation())).owner() != address(0)
                || !registry.isAllowed(address(swapAdapter)) || !registry.isAllowed(address(supplyAdapter))
                || !registry.isAllowed(address(withdrawAdapter)) || !allowlist.isAllowed(BASE_WETH)
                || !allowlist.isAllowed(BASE_USDC) || !allowlist.isAllowed(aWETH)
                || swapAdapter.pool() != BASE_EXPECTED_WETH_USDC_500_POOL || swapAdapter.token0() != BASE_WETH
                || swapAdapter.token1() != BASE_USDC || swapAdapter.fee() != BASE_FEE_500
                || supplyAdapter.pool() != BASE_AAVE_V3_POOL || supplyAdapter.asset() != BASE_WETH
                || withdrawAdapter.pool() != BASE_AAVE_V3_POOL || withdrawAdapter.asset() != BASE_WETH
                || withdrawAdapter.aToken() != aWETH || aWETH.code.length == 0
                || registry.pendingOwner() != (governance == deployer ? address(0) : governance)
                || allowlist.pendingOwner() != (governance == deployer ? address(0) : governance)
        ) revert DeploymentAssertionFailed();

        if (address(v2) != address(0)) _assertV2(v2, registry, allowlist);

        _baseReport(
            deployer, governance, registry, allowlist, factory, swapAdapter, supplyAdapter, withdrawAdapter, aWETH
        );
        _reportV2Candidate(deployV2Candidate, v2);
    }

    function _baseReport(
        address deployer,
        address governance,
        AdapterRegistry registry,
        TokenAllowlist allowlist,
        OpenZapFactory factory,
        BaseV3SwapAdapter swapAdapter,
        AaveV3SupplyAdapter supplyAdapter,
        AaveV3WithdrawAdapter withdrawAdapter,
        address aWETH
    ) internal view {
        console2.log("=== DeployEverything : Base (8453) ===");
        console2.log("chain id", block.chainid);
        console2.log("block", block.number);
        console2.log("deployer", deployer);
        console2.log("governance (proposed, must acceptOwnership)", governance);
        console2.log("core VERSION", factory.VERSION());
        console2.log("");
        console2.log("-- deployed now (a FRESH, disconnected v1.1 core) --");
        console2.log("AdapterRegistry", address(registry));
        console2.log("TokenAllowlist", address(allowlist));
        console2.log("OpenZapFactory", address(factory));
        console2.log("OpenZap implementation", factory.implementation());
        console2.log("BaseV3SwapAdapter (WETH/USDC 0.05%)", address(swapAdapter));
        console2.log("  -> pool", swapAdapter.pool());
        console2.log("AaveV3SupplyAdapter (WETH)", address(supplyAdapter));
        console2.log("  -> aToken", aWETH);
        console2.log("AaveV3WithdrawAdapter (WETH)", address(withdrawAdapter));
        console2.log("  -> aToken (tokenIn)", withdrawAdapter.aToken());
        console2.log("  -> asset (tokenOut)", withdrawAdapter.asset());
        console2.log("allowlisted: WETH", BASE_WETH);
        console2.log("allowlisted: USDC", BASE_USDC);
        console2.log("allowlisted: aWETH", aWETH);
        console2.log("superseded v1.0.0 factory (NOT used)", BASE_STALE_V1_0_0_FACTORY);
        console2.log("");
        if (governance != deployer) {
            console2.log("ACTION REQUIRED: governance must call acceptOwnership() on BOTH");
            console2.log("  AdapterRegistry", address(registry));
            console2.log("  TokenAllowlist", address(allowlist));
            console2.log("Until then the deployer is still the kill-switch holder.");
        } else {
            console2.log("WARNING: governance == deployer. Transfer both to a Safe before funding.");
        }
        console2.log("");
        console2.log("NOTE: src/lib/chains.ts is Robinhood-only by design (the builder's deploy handoff");
        console2.log("targets 4663). There are no Base frontend env vars to set from this run.");
    }

    // =========================================================================================== //
    // v2 candidate — OFF unless DEPLOY_V2_CANDIDATE=true. Track A HAS shipped OpenZapFactoryV2.        //
    // =========================================================================================== //

    /// @dev Called INSIDE the broadcast so the v2 factory deploys under the same signer. It is OFF
    ///      unless `DEPLOY_V2_CANDIDATE=true`. Deploying `OpenZapFactoryV2` deploys its bricked
    ///      implementation and custodies NOTHING — the risk is entirely in creating and FUNDING v2 zaps
    ///      through it, which this script never does. It is pointed at the same registry/allowlist as
    ///      the production core purely for read-only allowlist checks, and is never handed governance,
    ///      funded, or advertised to the frontend by this script. Returns `address(0)` when off.
    function _maybeDeployV2Candidate(bool flag, AdapterRegistry registry, TokenAllowlist allowlist)
        internal
        returns (OpenZapFactoryV2 factoryV2)
    {
        if (!flag) return OpenZapFactoryV2(address(0));
        factoryV2 = new OpenZapFactoryV2(registry, allowlist);
    }

    /// @dev Post-deploy assertion for the v2 candidate. Only asserts the factory's OWN surface, so this
    ///      script stays minimally coupled to Track A's in-flight implementation internals.
    function _assertV2(OpenZapFactoryV2 f, AdapterRegistry registry, TokenAllowlist allowlist) internal view {
        if (
            keccak256(bytes(f.VERSION())) != keccak256(bytes("2.0.0-candidate"))
                || address(f.adapters()) != address(registry) || address(f.tokens()) != address(allowlist)
                || f.implementation().code.length == 0 || f.implCodeHash() == bytes32(0)
        ) revert DeploymentAssertionFailed();
    }

    function _reportV2Candidate(bool flag, OpenZapFactoryV2 factoryV2) internal view {
        console2.log("");
        console2.log("-- v2 candidate (DEPLOY_V2_CANDIDATE) --");
        if (!flag) {
            console2.log("DEPLOY_V2_CANDIDATE is false (default). No v2 core deployed. Correct for prod.");
            return;
        }
        console2.log("!! UNAUDITED v2 CANDIDATE DEPLOYED. Read this. !!");
        console2.log("OpenZapFactoryV2", address(factoryV2));
        console2.log("  VERSION", factoryV2.VERSION());
        console2.log("  implementation (OpenZapV2)", factoryV2.implementation());
        console2.log("  adapters (shared, read-only)", address(factoryV2.adapters()));
        console2.log("  tokens (shared, read-only)", address(factoryV2.tokens()));
        console2.log("");
        console2.log("This factory is UNAUDITED and EXPERIMENTAL. Deploying it custodies no funds, but:");
        console2.log("  * it MUST NOT replace the live v1.1 factory,");
        console2.log("  * do NOT create or fund a v2 zap through it until it is independently reviewed,");
        console2.log("  * do NOT point the frontend (src/lib/*) at this factory or its zaps,");
        console2.log("  * do NOT hand it any governance role.");
        console2.log("It shares the production registry/allowlist for read-only allowlist checks only.");
    }

    // =========================================================================================== //
    // Helpers                                                                                      //
    // =========================================================================================== //

    /// @dev `satisfied` means the on-chain state ALREADY matches what the call would produce — either
    ///      this run made the call, or it was already true. Anything marked PENDING has not happened and
    ///      will not without the owner sending it.
    function _printCall(bool satisfied, string memory label, bytes memory data) internal pure {
        console2.log(satisfied ? "  [satisfied on chain]" : "  [PENDING - owner must send]", label);
        console2.log("    calldata");
        console2.logBytes(data);
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    /// @dev The Robinhood frontend-config note, in its own frame so it does not add to the deploy
    ///      function's stack (that function sits on via_ir's exact stack-depth limit). Text is accurate
    ///      to the shipped catalogue: USDG and the ZapVault venue ARE selectable, so these vars are live.
}
