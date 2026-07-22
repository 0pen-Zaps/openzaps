// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {RobinhoodV4PoolAdapter} from "../src/adapters/RobinhoodV4PoolAdapter.sol";
import {ZapVault} from "../src/primitives/ZapVault.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {SafeApprove} from "../src/libraries/SafeApprove.sol";

/// @dev Read-only window into the v4 PoolManager, used to refuse a dead pool at deploy time.
interface IPoolManagerRead {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title DeployRobinhoodExpansion
/// @notice Adds two contracts to the EXISTING, ALREADY-DEPLOYED OpenZap v1.1.0 set on Robinhood
///         Chain (4663):
///           1. `RobinhoodV4PoolAdapter` — an exact-input swap adapter for ONE named Uniswap-v4
///              pool, with the whole PoolKey supplied as constructor arguments.
///           2. `ZapVault` — a minimal, admin-less ERC-4626 vault, optionally seeded in the same
///              run so the empty-vault donation grief is closed before anyone else can reach it.
///
/// @dev THIS SCRIPT DEPLOYS NOTHING ELSE. It does not deploy a registry, an allowlist, a factory or
///      an OpenZap implementation. Those already exist on chain 4663 and are pinned as constants
///      below, copied from `src/lib/robinhood.ts`:
///
///        AdapterRegistry 0x9E56e444f490C00A6277326A47Cb462E12dF1f17
///        TokenAllowlist  0x87fBb77a4328B068CADbA2eBE5dBCE0ffbd7141B
///        OpenZapFactory  0xFC775017b25d2458623E2f3E735A4B750dD8b4E4  (VERSION 1.1.0)
///
///      Use `DeployRobinhood.s.sol` only if you deliberately want a brand new, disconnected core.
///      Running that again would orphan every capsule the live factory has already produced.
///
///      WHO CAN DO WHAT — this is the part to read twice.
///
///      The deployer (whoever `--sender` names) can ALWAYS do these, because they need no
///      permission from anybody:
///        * deploy the adapter,
///        * deploy the vault,
///        * seed the vault with their own assets.
///
///      The deployer can do these ONLY IF they happen to be the current `owner()` of the
///      corresponding governance contract:
///        * `AdapterRegistry.setAdapter(adapter, true)`,
///        * `TokenAllowlist.setToken(token, true)` for each currency and for the vault share token.
///
///      The script checks `owner()` live and takes the branch that is actually available. When the
///      deployer is not the owner it does NOT pretend: it skips those calls, the run still succeeds,
///      and it prints the exact calls — including raw calldata — that the registry/allowlist owner
///      must send afterwards. Until those land, the new adapter is NOT callable from a zap and the
///      vault share token is NOT a legal `outAsset` or step output.
///
///      NO KEY MATERIAL. `vm.startBroadcast()` takes no argument, so the signer comes from the forge
///      CLI (`--ledger`, `--trezor`, `--account`, `--interactive`, or an external signer) and the
///      deployer address is whatever `--sender` names. This script never reads a private key, and
///      `GOVERNANCE` is an ADDRESS used for reporting only — this script cannot and does not
///      transfer ownership of contracts it did not deploy.
///
///      ENVIRONMENT (every one optional; defaults are the measured Robinhood Chain values):
///        GOVERNANCE           address  who *should* end up owning governance. Reporting only.
///                                      Default: the live `AdapterRegistry.owner()`.
///        POOL_CURRENCY0       address  default aeWETH 0x0Bd7...AD73
///        POOL_CURRENCY1       address  default USDG   0x5fc5...d168
///        POOL_FEE             uint     default 450 (static, 0.045%). 0x800000 == dynamic.
///        POOL_TICK_SPACING    int      default 9
///        POOL_HOOKS           address  default address(0) (hookless)
///        EXPECTED_POOL_ID     bytes32  default 0x6ba18d46...5d2 — the deepest LIVE hookless
///                                      aeWETH/USDG pool, chosen by reading every Initialize log
///                                      for the pair and comparing on-chain liquidity. If you
///                                      change any pool field you MUST change this too; the run
///                                      aborts otherwise.
///        REQUIRE_POOL_LIQUIDITY bool   default true. Reads the pool's live liquidity out of the
///                                      PoolManager and refuses to deploy an adapter for a dead
///                                      pool.
///        VAULT_ASSET          address  default USDG
///        VAULT_NAME           string   default "OpenZap USDG Vault"
///        VAULT_SYMBOL         string   default "ozUSDG"
///        VAULT_SEED_ASSETS    uint     default 1_000_000 (== 1.000000 USDG at 6dp). The deployer
///                                      must already hold this; the run aborts with
///                                      `UnfundedSeed` rather than deploying a grief-able vault.
///                                      Set to 0 to skip seeding — allowed, but the script prints a
///                                      loud warning and you own the consequence.
///        VAULT_SEED_RECIPIENT address  default 0x...dEaD. The seed shares are sent here and are
///                                      intended to be unredeemable forever, which is what makes
///                                      the price floor permanent. Point it at yourself only if you
///                                      understand that redeeming re-opens the grief.
///
///      WHAT THIS SCRIPT REFUSES TO DO:
///        * It refuses to run on any chain other than 4663.
///        * It refuses to run against a factory that is not wired to the pinned registry/allowlist,
///          or whose `VERSION()` is not "1.1.0".
///        * It refuses to deploy an adapter whose resulting `poolId()` is not the one you named.
///        * It refuses to deploy an adapter for a pool with zero live liquidity (unless you
///          explicitly set REQUIRE_POOL_LIQUIDITY=false).
///        * It refuses to deploy an unseeded vault unless you explicitly ask for one.
///        * It refuses to claim a governance call happened when it did not.
contract DeployRobinhoodExpansion is Script {
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

    // --- deep currencies ------------------------------------------------------------------------ //
    address internal constant AEWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73; // 18dp, symbol WETH
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; //  6dp

    // --- default pool: the deepest LIVE hookless aeWETH/USDG pool ------------------------------- //
    uint24 internal constant DEFAULT_FEE = 450;
    int24 internal constant DEFAULT_TICK_SPACING = 9;
    bytes32 internal constant DEFAULT_POOL_ID = 0x6ba18d461bfe3df70a80b50a4700e330e49efdaf597901b931f210554a5035d2;

    /// @dev v4 `StateLibrary.POOLS_SLOT`, and the offset of `Pool.State.liquidity` inside it.
    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;

    /// @dev Standard burn sink. The vault refuses `address(0)` as a receiver, so the seed shares go
    ///      here instead — same effect, permanently unredeemable.
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant DEFAULT_SEED_ASSETS = 1_000_000; // 1.000000 USDG

    error WrongChain(uint256 actual);
    error MissingCode(address target);
    error ZeroGovernance();
    error UnexpectedCoreVersion(string actual);
    error FactoryNotWiredToPinnedGovernance(address adapters, address tokens);
    error UnexpectedPoolId(bytes32 expected, bytes32 actual);
    error DeadPool(bytes32 poolId);
    error FeeOutOfRange(uint256 value);
    error TickSpacingOutOfRange(int256 value);
    error UnfundedSeed(address asset, uint256 needed, uint256 held);
    error SeedProducedNoShares();
    error DeploymentAssertionFailed();

    struct Config {
        address deployer;
        address governance;
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes32 expectedPoolId;
        bool requireLiquidity;
        address vaultAsset;
        string vaultName;
        string vaultSymbol;
        uint256 seedAssets;
        address seedRecipient;
    }

    function run() external returns (RobinhoodV4PoolAdapter adapter, ZapVault vault) {
        Config memory cfg = _config();

        AdapterRegistry registry = AdapterRegistry(ADAPTER_REGISTRY);
        TokenAllowlist allowlist = TokenAllowlist(TOKEN_ALLOWLIST);

        _preflight(cfg, registry, allowlist);

        address registryOwner = registry.owner();
        address allowlistOwner = allowlist.owner();
        bool deployerOwnsRegistry = cfg.deployer == registryOwner;
        bool deployerOwnsAllowlist = cfg.deployer == allowlistOwner;

        // Which allowlist entries are actually missing right now. Read before broadcasting so the
        // printed governance list is the real remaining work, not a blanket re-set of everything.
        bool needCurrency0 = !allowlist.isAllowed(cfg.currency0);
        bool needCurrency1 = !allowlist.isAllowed(cfg.currency1);

        // ---- deploy --------------------------------------------------------------------------- //
        vm.startBroadcast();

        adapter = new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, cfg.currency0, cfg.currency1, cfg.fee, cfg.tickSpacing, cfg.hooks
        );

        vault = new ZapVault(cfg.vaultAsset, cfg.vaultName, cfg.vaultSymbol);

        // Seed inside the same run. An empty ZapVault can be griefed: donating X before the first
        // deposit sets a price floor of X/1000 per share and makes smaller deposits revert. Nothing
        // is stolen, but seeding closes it, and the seed shares are burned so the floor is permanent.
        uint256 seedShares;
        if (cfg.seedAssets != 0) {
            cfg.vaultAsset.approveExact(address(vault), cfg.seedAssets);
            seedShares = vault.deposit(cfg.seedAssets, cfg.seedRecipient);
            if (seedShares == 0) revert SeedProducedNoShares();
            // Leave no standing approval behind, exactly as the adapters do.
            cfg.vaultAsset.approveExact(address(vault), 0);
        }

        // ---- governance wiring, only where the deployer actually has the right ------------------ //
        if (deployerOwnsRegistry) {
            registry.setAdapter(address(adapter), true);
        }
        if (deployerOwnsAllowlist) {
            if (needCurrency0) allowlist.setToken(cfg.currency0, true);
            if (needCurrency1) allowlist.setToken(cfg.currency1, true);
            allowlist.setToken(address(vault), true);
        }

        vm.stopBroadcast();

        // ---- post-deploy assertions ------------------------------------------------------------- //
        if (
            adapter.poolId() != cfg.expectedPoolId || adapter.universalRouter() != UNIVERSAL_ROUTER
                || adapter.permit2() != PERMIT2 || adapter.currency0() != cfg.currency0
                || adapter.currency1() != cfg.currency1 || adapter.fee() != cfg.fee
                || adapter.tickSpacing() != cfg.tickSpacing || adapter.hooks() != cfg.hooks
                || vault.asset() != cfg.vaultAsset || address(vault).code.length == 0
                || (cfg.seedAssets != 0 && (vault.totalAssets() != cfg.seedAssets || vault.totalSupply() != seedShares))
                || (deployerOwnsRegistry && !registry.isAllowed(address(adapter)))
                || (deployerOwnsAllowlist && !allowlist.isAllowed(address(vault)))
                || (deployerOwnsAllowlist && !allowlist.isAllowed(cfg.currency0))
                || (deployerOwnsAllowlist && !allowlist.isAllowed(cfg.currency1))
        ) revert DeploymentAssertionFailed();

        _report(cfg, adapter, vault, seedShares, registryOwner, allowlistOwner);
        _reportGovernanceWork(cfg, registry, allowlist, address(adapter), address(vault));
    }

    // ------------------------------------------------------------------------------------------- //
    // Configuration                                                                               //
    // ------------------------------------------------------------------------------------------- //

    function _config() internal view returns (Config memory cfg) {
        cfg.deployer = msg.sender; // from --sender / the configured signer; never a key in here
        cfg.governance = vm.envOr("GOVERNANCE", AdapterRegistry(ADAPTER_REGISTRY).owner());
        if (cfg.governance == address(0)) revert ZeroGovernance();

        cfg.currency0 = vm.envOr("POOL_CURRENCY0", AEWETH);
        cfg.currency1 = vm.envOr("POOL_CURRENCY1", USDG);

        uint256 rawFee = vm.envOr("POOL_FEE", uint256(DEFAULT_FEE));
        if (rawFee > type(uint24).max) revert FeeOutOfRange(rawFee);
        // forge-lint: disable-next-line(unsafe-typecast)
        cfg.fee = uint24(rawFee);

        int256 rawTickSpacing = vm.envOr("POOL_TICK_SPACING", int256(DEFAULT_TICK_SPACING));
        if (rawTickSpacing < type(int24).min || rawTickSpacing > type(int24).max) {
            revert TickSpacingOutOfRange(rawTickSpacing);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        cfg.tickSpacing = int24(rawTickSpacing);

        cfg.hooks = vm.envOr("POOL_HOOKS", address(0));
        cfg.expectedPoolId = vm.envOr("EXPECTED_POOL_ID", DEFAULT_POOL_ID);
        cfg.requireLiquidity = vm.envOr("REQUIRE_POOL_LIQUIDITY", true);

        cfg.vaultAsset = vm.envOr("VAULT_ASSET", USDG);
        cfg.vaultName = vm.envOr("VAULT_NAME", string("OpenZap USDG Vault"));
        cfg.vaultSymbol = vm.envOr("VAULT_SYMBOL", string("ozUSDG"));
        cfg.seedAssets = vm.envOr("VAULT_SEED_ASSETS", DEFAULT_SEED_ASSETS);
        cfg.seedRecipient = vm.envOr("VAULT_SEED_RECIPIENT", DEAD);
    }

    // ------------------------------------------------------------------------------------------- //
    // Preflight — every check here happens BEFORE a single byte is broadcast                      //
    // ------------------------------------------------------------------------------------------- //

    function _preflight(Config memory cfg, AdapterRegistry registry, TokenAllowlist allowlist) internal view {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid);

        _requireCode(ADAPTER_REGISTRY);
        _requireCode(TOKEN_ALLOWLIST);
        _requireCode(OPENZAP_FACTORY);
        _requireCode(UNIVERSAL_ROUTER);
        _requireCode(PERMIT2);
        _requireCode(POOL_MANAGER);
        _requireCode(cfg.currency0);
        _requireCode(cfg.currency1);
        _requireCode(cfg.vaultAsset);
        if (cfg.hooks != address(0)) _requireCode(cfg.hooks);

        // The live core must be the one we think it is. A factory pointing at a different registry
        // means allowlisting here would have no effect on the capsules people actually create.
        OpenZapFactory factory = OpenZapFactory(OPENZAP_FACTORY);
        if (keccak256(bytes(factory.VERSION())) != keccak256(bytes(EXPECTED_VERSION))) {
            revert UnexpectedCoreVersion(factory.VERSION());
        }
        if (address(factory.adapters()) != ADAPTER_REGISTRY || address(factory.tokens()) != TOKEN_ALLOWLIST) {
            revert FactoryNotWiredToPinnedGovernance(address(factory.adapters()), address(factory.tokens()));
        }
        // Touch both so a swapped-out governance contract fails here rather than mid-run.
        registry.owner();
        allowlist.owner();

        // The pool must be the one named, and it must be alive. `keccak256(abi.encode(poolKey))` is
        // the v4 pool id; the adapter recomputes it identically, but checking here means a mistyped
        // fee or tickSpacing costs nothing instead of costing a deployment.
        bytes32 poolId = keccak256(abi.encode(cfg.currency0, cfg.currency1, cfg.fee, cfg.tickSpacing, cfg.hooks));
        if (poolId != cfg.expectedPoolId) revert UnexpectedPoolId(cfg.expectedPoolId, poolId);
        if (cfg.requireLiquidity && _liquidity(poolId) == 0) revert DeadPool(poolId);

        // Seeding is funded by the deployer's own balance. Fail here, not after two deployments.
        if (cfg.seedAssets != 0) {
            uint256 held = IERC20(cfg.vaultAsset).balanceOf(cfg.deployer);
            if (held < cfg.seedAssets) revert UnfundedSeed(cfg.vaultAsset, cfg.seedAssets, held);
        }
    }

    /// @dev Live `liquidity` for a pool, read straight out of the PoolManager's state.
    function _liquidity(bytes32 poolId) internal view returns (uint128) {
        bytes32 stateSlot = keccak256(abi.encodePacked(poolId, POOLS_SLOT));
        bytes32 word = IPoolManagerRead(POOL_MANAGER).extsload(bytes32(uint256(stateSlot) + LIQUIDITY_OFFSET));
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(uint256(word));
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    // ------------------------------------------------------------------------------------------- //
    // Reporting                                                                                   //
    // ------------------------------------------------------------------------------------------- //

    function _report(
        Config memory cfg,
        RobinhoodV4PoolAdapter adapter,
        ZapVault vault,
        uint256 seedShares,
        address registryOwner,
        address allowlistOwner
    ) internal view {
        console2.log("=== DeployRobinhoodExpansion ===");
        console2.log("chain id", block.chainid);
        console2.log("block", block.number);
        console2.log("deployer (--sender)", cfg.deployer);
        console2.log("intended governance", cfg.governance);
        console2.log("");
        console2.log("-- existing core, NOT deployed by this script --");
        console2.log("OpenZapFactory", OPENZAP_FACTORY);
        console2.log("AdapterRegistry", ADAPTER_REGISTRY);
        console2.log("  owner", registryOwner);
        console2.log("  pendingOwner", AdapterRegistry(ADAPTER_REGISTRY).pendingOwner());
        console2.log("TokenAllowlist", TOKEN_ALLOWLIST);
        console2.log("  owner", allowlistOwner);
        console2.log("  pendingOwner", TokenAllowlist(TOKEN_ALLOWLIST).pendingOwner());
        console2.log("");
        console2.log("-- deployed now --");
        console2.log("RobinhoodV4PoolAdapter", address(adapter));
        console2.log("  currency0", adapter.currency0());
        console2.log("  currency1", adapter.currency1());
        console2.log("  fee", uint256(adapter.fee()));
        console2.log("  tickSpacing", int256(adapter.tickSpacing()));
        console2.log("  hooks", adapter.hooks());
        console2.log("  poolId");
        console2.logBytes32(adapter.poolId());
        console2.log("  live pool liquidity", uint256(_liquidity(adapter.poolId())));
        console2.log("ZapVault", address(vault));
        console2.log("  asset", vault.asset());
        console2.log("  name", vault.name());
        console2.log("  symbol", vault.symbol());
        console2.log("  share decimals", uint256(vault.decimals()));
        if (cfg.seedAssets != 0) {
            console2.log("  seeded assets", cfg.seedAssets);
            console2.log("  seed shares", seedShares);
            console2.log("  seed shares sent to (unredeemable by design)", cfg.seedRecipient);
        } else {
            console2.log("  WARNING: vault deployed UNSEEDED.");
            console2.log("  An empty ZapVault is grief-able: a donation of X before the first");
            console2.log("  deposit sets a price floor of X/1000 per share and makes smaller");
            console2.log("  deposits revert with ZeroShares. Nothing can be stolen, but deposits");
            console2.log("  can be blocked. Seed it before advertising it.");
        }
    }

    function _reportGovernanceWork(
        Config memory cfg,
        AdapterRegistry registry,
        TokenAllowlist allowlist,
        address adapter,
        address vault
    ) internal view {
        console2.log("");
        console2.log("-- governance --");

        bool adapterLive = registry.isAllowed(adapter);
        bool vaultLive = allowlist.isAllowed(vault);
        bool c0Live = allowlist.isAllowed(cfg.currency0);
        bool c1Live = allowlist.isAllowed(cfg.currency1);

        if (adapterLive && vaultLive && c0Live && c1Live) {
            console2.log("DONE. The deployer owned both governance contracts, so every call below");
            console2.log("was executed in this run. Nothing further is required.");
        } else {
            console2.log("ACTION REQUIRED. At least one entry below is still PENDING, because the");
            console2.log("deployer is not the owner of the governance contract it belongs to.");
            console2.log("Until every PENDING call lands, the new adapter is not callable from any");
            console2.log("zap and the vault share token cannot be a step output or an outAsset.");
        }

        console2.log("");
        console2.log("registry owner must send to", address(registry));
        _printCall(
            adapterLive,
            "AdapterRegistry.setAdapter(adapter, true)",
            abi.encodeCall(registry.setAdapter, (adapter, true))
        );

        console2.log("");
        console2.log("allowlist owner must send to", address(allowlist));
        _printCall(
            c0Live,
            "TokenAllowlist.setToken(currency0, true)",
            abi.encodeCall(allowlist.setToken, (cfg.currency0, true))
        );
        _printCall(
            c1Live,
            "TokenAllowlist.setToken(currency1, true)",
            abi.encodeCall(allowlist.setToken, (cfg.currency1, true))
        );
        _printCall(
            vaultLive, "TokenAllowlist.setToken(vaultShare, true)", abi.encodeCall(allowlist.setToken, (vault, true))
        );

        address registryPending = registry.pendingOwner();
        address allowlistPending = allowlist.pendingOwner();
        if (registryPending != address(0) || allowlistPending != address(0)) {
            console2.log("");
            console2.log("NOTE: an ownership handoff is still pending and NOT accepted.");
            if (registryPending != address(0)) {
                console2.log("  AdapterRegistry pendingOwner must call acceptOwnership()", registryPending);
            }
            if (allowlistPending != address(0)) {
                console2.log("  TokenAllowlist pendingOwner must call acceptOwnership()", allowlistPending);
            }
            console2.log("  Until then the CURRENT owner is still the one that must send the calls above.");
        }

        console2.log("");
        console2.log("STILL MISSING, and this script cannot supply it: there is no adapter that");
        console2.log("deposits into ZapVault, so the vault is not yet reachable from a zap step.");
        console2.log("A deposit adapter calling vault.deposit(amountIn, msg.sender) must be written,");
        console2.log("fork-tested and allowlisted before the vault is part of any capsule.");
    }

    /// @dev `satisfied` means the on-chain state is ALREADY what the call would produce — either
    ///      this run made the call, or it was already true beforehand. Anything marked PENDING has
    ///      not happened and will not happen without the owner sending it.
    function _printCall(bool satisfied, string memory label, bytes memory data) internal pure {
        console2.log(satisfied ? "  [satisfied on chain]" : "  [PENDING - owner must send]", label);
        console2.log("    calldata");
        console2.logBytes(data);
    }
}
