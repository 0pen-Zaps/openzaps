// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {RobinhoodV4PoolAdapter} from "../src/adapters/RobinhoodV4PoolAdapter.sol";
import {ZapVaultDepositAdapter} from "../src/adapters/ZapVaultDepositAdapter.sol";
import {ZapVaultRedeemAdapter} from "../src/adapters/ZapVaultRedeemAdapter.sol";
import {ZapVault} from "../src/primitives/ZapVault.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {SafeApprove} from "../src/libraries/SafeApprove.sol";

/// @dev Read-only window into the v4 PoolManager, used to refuse a dead pool at deploy time.
interface IPoolManagerRead {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title DeployRobinhoodExpansion
/// @notice Adds four contracts to the EXISTING, ALREADY-DEPLOYED OpenZap v1.1.0 set on Robinhood
///         Chain (4663):
///           1. `RobinhoodV4PoolAdapter` — an exact-input swap adapter for ONE named Uniswap-v4
///              pool, with the whole PoolKey supplied as constructor arguments.
///           2. `ZapVault` — a minimal, admin-less ERC-4626 vault, optionally seeded in the same
///              run so the empty-vault donation grief is closed before anyone else can reach it.
///           3. `ZapVaultDepositAdapter` — the only way a zap step can enter the vault: asset in,
///              shares out, shares booked to the calling zap.
///           4. `ZapVaultRedeemAdapter` — the unwind leg: shares in, asset out, both booked to the
///              calling zap. Without it a vault position is a one-way door that only the zap
///              owner's `emergencyExit` could reopen.
///
///      THE ALLOWLIST ENTRY PEOPLE FORGET. A step's `tokenOut` must be allowlisted or
///      `OpenZap.execute` reverts `InvalidAdapterResult`; a step's `tokenIn` must be allowlisted or
///      `initialize` reverts `TokenNotAllowed`. The vault SHARE TOKEN (the vault address itself) is
///      the deposit step's `tokenOut` AND the redeem step's `tokenIn`, so **the share token must be
///      in `TokenAllowlist` or neither vault adapter is usable at all.** The vault's underlying
///      asset must be allowlisted for the same reason on the mirrored legs. This script allowlists
///      both when it is allowed to, and prints them as PENDING with raw calldata when it is not.
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
///        * `AdapterRegistry.setAdapter(adapter, true)` for the swap, deposit and redeem adapters,
///        * `TokenAllowlist.setToken(token, true)` for each pool currency, for the vault's
///          underlying asset, and for the vault SHARE TOKEN.
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

    /// @dev Everything this run produced. Grouped so `run` stays readable and the reporters take one
    ///      argument instead of six.
    struct Deployed {
        RobinhoodV4PoolAdapter swapAdapter;
        ZapVault vault;
        ZapVaultDepositAdapter depositAdapter;
        ZapVaultRedeemAdapter redeemAdapter;
        uint256 seedShares;
    }

    function run() external returns (Deployed memory d) {
        Config memory cfg = _config();

        AdapterRegistry registry = AdapterRegistry(ADAPTER_REGISTRY);
        TokenAllowlist allowlist = TokenAllowlist(TOKEN_ALLOWLIST);

        _preflight(cfg, registry, allowlist);

        address registryOwner = registry.owner();
        address allowlistOwner = allowlist.owner();
        bool deployerOwnsRegistry = cfg.deployer == registryOwner;
        bool deployerOwnsAllowlist = cfg.deployer == allowlistOwner;

        // ---- deploy --------------------------------------------------------------------------- //
        vm.startBroadcast();

        d.swapAdapter = new RobinhoodV4PoolAdapter(
            UNIVERSAL_ROUTER, PERMIT2, cfg.currency0, cfg.currency1, cfg.fee, cfg.tickSpacing, cfg.hooks
        );

        d.vault = new ZapVault(cfg.vaultAsset, cfg.vaultName, cfg.vaultSymbol);

        // The two adapters that make the vault reachable from a frozen policy. Both read `asset()`
        // off the vault in their own constructors, so a vault/asset mismatch cannot be introduced
        // here — and both carry the same 4663 chain guard the swap adapter does.
        d.depositAdapter = new ZapVaultDepositAdapter(address(d.vault));
        d.redeemAdapter = new ZapVaultRedeemAdapter(address(d.vault));

        // Seed inside the same run. An empty ZapVault can be griefed: donating X before the first
        // deposit sets a price floor of X/1000 per share and makes smaller deposits revert. Nothing
        // is stolen, but seeding closes it, and the seed shares are burned so the floor is permanent.
        if (cfg.seedAssets != 0) {
            cfg.vaultAsset.approveExact(address(d.vault), cfg.seedAssets);
            d.seedShares = d.vault.deposit(cfg.seedAssets, cfg.seedRecipient);
            if (d.seedShares == 0) revert SeedProducedNoShares();
            // Leave no standing approval behind, exactly as the adapters do.
            cfg.vaultAsset.approveExact(address(d.vault), 0);
        }

        // ---- governance wiring, only where the deployer actually has the right ------------------ //
        if (deployerOwnsRegistry) {
            registry.setAdapter(address(d.swapAdapter), true);
            registry.setAdapter(address(d.depositAdapter), true);
            registry.setAdapter(address(d.redeemAdapter), true);
        }
        if (deployerOwnsAllowlist) {
            // Guarded on the live flag so an already-allowed token costs no gas, and so a
            // `vaultAsset` that happens to equal a pool currency is not written twice.
            _allowToken(allowlist, cfg.currency0);
            _allowToken(allowlist, cfg.currency1);
            // The vault's underlying: deposit-step `tokenIn`, redeem-step `tokenOut`.
            _allowToken(allowlist, cfg.vaultAsset);
            // The SHARE TOKEN: deposit-step `tokenOut`, redeem-step `tokenIn`. Without this entry
            // both vault adapters are dead on arrival.
            _allowToken(allowlist, address(d.vault));
        }

        vm.stopBroadcast();

        _assertDeployment(cfg, d, registry, allowlist, deployerOwnsRegistry, deployerOwnsAllowlist);

        _report(cfg, d, registryOwner, allowlistOwner);
        _reportGovernanceWork(cfg, d, registry, allowlist);
    }

    /// @dev `setToken` is idempotent, but reading first keeps the broadcast free of no-op writes and
    ///      makes the dedupe between `vaultAsset` and the pool currencies automatic.
    function _allowToken(TokenAllowlist allowlist, address token) internal {
        if (!allowlist.isAllowed(token)) allowlist.setToken(token, true);
    }

    /// @dev Split out of `run` purely to keep that function under the stack limit.
    function _assertDeployment(
        Config memory cfg,
        Deployed memory d,
        AdapterRegistry registry,
        TokenAllowlist allowlist,
        bool deployerOwnsRegistry,
        bool deployerOwnsAllowlist
    ) internal view {
        // The swap adapter is wired to the pool that was named.
        if (
            d.swapAdapter.poolId() != cfg.expectedPoolId || d.swapAdapter.universalRouter() != UNIVERSAL_ROUTER
                || d.swapAdapter.permit2() != PERMIT2 || d.swapAdapter.currency0() != cfg.currency0
                || d.swapAdapter.currency1() != cfg.currency1 || d.swapAdapter.fee() != cfg.fee
                || d.swapAdapter.tickSpacing() != cfg.tickSpacing || d.swapAdapter.hooks() != cfg.hooks
        ) revert DeploymentAssertionFailed();

        // The vault is the vault that was asked for, and the seed actually landed.
        if (
            d.vault.asset() != cfg.vaultAsset || address(d.vault).code.length == 0
                || (cfg.seedAssets != 0
                    && (d.vault.totalAssets() != cfg.seedAssets || d.vault.totalSupply() != d.seedShares))
        ) revert DeploymentAssertionFailed();

        // Both vault adapters point at THIS vault and agree with it about the underlying asset.
        if (
            d.depositAdapter.vault() != address(d.vault) || d.depositAdapter.asset() != cfg.vaultAsset
                || d.redeemAdapter.vault() != address(d.vault) || d.redeemAdapter.asset() != cfg.vaultAsset
        ) revert DeploymentAssertionFailed();

        // Governance only where it was actually exercised — never assert a call we skipped.
        if (deployerOwnsRegistry) {
            if (
                !registry.isAllowed(address(d.swapAdapter)) || !registry.isAllowed(address(d.depositAdapter))
                    || !registry.isAllowed(address(d.redeemAdapter))
            ) revert DeploymentAssertionFailed();
        }
        if (deployerOwnsAllowlist) {
            if (
                !allowlist.isAllowed(cfg.currency0) || !allowlist.isAllowed(cfg.currency1)
                    || !allowlist.isAllowed(cfg.vaultAsset) || !allowlist.isAllowed(address(d.vault))
            ) revert DeploymentAssertionFailed();
        }
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

    function _report(Config memory cfg, Deployed memory d, address registryOwner, address allowlistOwner)
        internal
        view
    {
        RobinhoodV4PoolAdapter adapter = d.swapAdapter;
        ZapVault vault = d.vault;
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
        console2.log("ZapVaultDepositAdapter", address(d.depositAdapter));
        console2.log("  vault", d.depositAdapter.vault());
        console2.log("  asset (tokenIn)", d.depositAdapter.asset());
        console2.log("  tokenOut is the share token", address(vault));
        console2.log("ZapVaultRedeemAdapter", address(d.redeemAdapter));
        console2.log("  vault (tokenIn)", d.redeemAdapter.vault());
        console2.log("  asset (tokenOut)", d.redeemAdapter.asset());
        if (cfg.seedAssets != 0) {
            console2.log("  seeded assets", cfg.seedAssets);
            console2.log("  seed shares", d.seedShares);
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
        Deployed memory d,
        AdapterRegistry registry,
        TokenAllowlist allowlist
    ) internal view {
        console2.log("");
        console2.log("-- governance --");

        address vault = address(d.vault);
        bool swapLive = registry.isAllowed(address(d.swapAdapter));
        bool depositLive = registry.isAllowed(address(d.depositAdapter));
        bool redeemLive = registry.isAllowed(address(d.redeemAdapter));
        bool vaultShareLive = allowlist.isAllowed(vault);
        bool assetLive = allowlist.isAllowed(cfg.vaultAsset);
        bool c0Live = allowlist.isAllowed(cfg.currency0);
        bool c1Live = allowlist.isAllowed(cfg.currency1);

        if (swapLive && depositLive && redeemLive && vaultShareLive && assetLive && c0Live && c1Live) {
            console2.log("DONE. The deployer owned both governance contracts, so every call below");
            console2.log("was executed in this run. Nothing further is required.");
        } else {
            console2.log("ACTION REQUIRED. At least one entry below is still PENDING, because the");
            console2.log("deployer is not the owner of the governance contract it belongs to.");
            console2.log("Until every PENDING call lands, the new adapters are not callable from any");
            console2.log("zap and the vault share token cannot be a step input, a step output, or an");
            console2.log("outAsset.");
        }

        console2.log("");
        console2.log("registry owner must send to", address(registry));
        _printCall(
            swapLive,
            "AdapterRegistry.setAdapter(swapAdapter, true)",
            abi.encodeCall(registry.setAdapter, (address(d.swapAdapter), true))
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
            assetLive,
            "TokenAllowlist.setToken(vaultAsset, true)   <- deposit tokenIn / redeem tokenOut",
            abi.encodeCall(allowlist.setToken, (cfg.vaultAsset, true))
        );
        _printCall(
            vaultShareLive,
            "TokenAllowlist.setToken(vaultShare, true)   <- REQUIRED: deposit tokenOut / redeem tokenIn",
            abi.encodeCall(allowlist.setToken, (vault, true))
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
        console2.log("-- what this deployment does NOT give you --");
        console2.log("1. ZapVault is UNAUDITED and custodies real funds. It has been unit-tested by");
        console2.log("   the same agent that wrote it, which is not a review. It earns nothing:");
        console2.log("   totalAssets() is literally asset.balanceOf(vault). Do not present it as a");
        console2.log("   yield product. See ROBINHOOD_EXPANSION.md section 3.");
        console2.log("2. A deposit-then-redeem round trip in ONE capsule cannot settle. Settlement");
        console2.log("   measures balanceOf(outAsset) after minus before, so a run that spends the");
        console2.log("   asset and returns it nets to zero at best and underflow-reverts once");
        console2.log("   rounding bites. Redeem belongs in a capsule FUNDED WITH SHARES.");
        console2.log("3. Step.amountIn is frozen at signing. A redeem step cannot consume whatever");
        console2.log("   the deposit step minted; the share count must be named in advance and any");
        console2.log("   surplus strands until the owner calls emergencyExit.");
        console2.log("4. The builder cannot draw a supply chain yet: send accepts a token and the");
        console2.log("   vault share is a receipt, so compileChain rejects it. That is front-end");
        console2.log("   work, not a contract gap. See BASE_CAPABILITIES.md section 4b.");

        console2.log("");
        console2.log("-- frontend configuration (src/lib/chains.ts) --");
        console2.log("The builder decides what it will OFFER TO SIGN from these env vars. Setting");
        console2.log("one is the moment the product starts telling users a step is deployable, so");
        console2.log("set it LAST: only after the adapter is allowlisted above AND the registry");
        console2.log("entry in src/lib/chains.ts still describes it exactly (same tokens, same");
        console2.log("welded vault). An entry that has drifted from the contract it names is how a");
        console2.log("user signs a policy that does something other than what the block said.");
        console2.log("An unset or malformed value fails CLOSED: the step is treated as undeployed.");
        console2.log("");
        console2.log("NEXT_PUBLIC_OPENZAP_ROBINHOOD_V4_ADAPTER", address(d.swapAdapter));
        console2.log("NEXT_PUBLIC_OPENZAP_ZAP_VAULT_DEPOSIT_ADAPTER", address(d.depositAdapter));
        console2.log("NEXT_PUBLIC_OPENZAP_ZAP_VAULT_REDEEM_ADAPTER", address(d.redeemAdapter));
        console2.log("");
        console2.log("NOTE: setting the two vault vars alone changes NOTHING a user can draw. The");
        console2.log("catalogue in src/lib/blocks.ts offers no USDG asset and no ZapVault market, so");
        console2.log("no drawn chain selects these entries and no deployed adapter produces USDG to");
        console2.log("feed one. Making a vault step reachable is a separate, deliberate catalogue");
        console2.log("change -- and it is the one that must carry honest copy for what a deposit");
        console2.log("into an unaudited, non-yield-bearing vault actually does.");

        // Drift guard. src/lib/chains.ts hard-codes USDG / ozUSDG on both vault rows, because
        // that is what this script deploys by default. VAULT_ASSET and VAULT_SYMBOL are env
        // overrides, so a non-default run silently makes those two rows describe a vault that
        // does not exist -- and the registry entry is what the builder shows a user before they
        // sign. Fail loud here rather than let the frontend claim the wrong token.
        bool assetDrifted = cfg.vaultAsset != USDG;
        bool symbolDrifted = keccak256(bytes(cfg.vaultSymbol)) != keccak256(bytes("ozUSDG"));
        if (assetDrifted || symbolDrifted) {
            console2.log("");
            console2.log("WARNING: this vault does NOT match what src/lib/chains.ts describes.");
            if (assetDrifted) {
                console2.log("  VAULT_ASSET is not the USDG the registry rows name:", cfg.vaultAsset);
            }
            if (symbolDrifted) {
                console2.log("  VAULT_SYMBOL is not the 'ozUSDG' the registry rows name:", cfg.vaultSymbol);
            }
            console2.log("  The two vault entries in src/lib/chains.ts carry tokenIn/tokenOut symbols");
            console2.log("  USDG and ozUSDG. They are WRONG for this deployment. Correct them in the");
            console2.log("  SAME change that sets the env vars above -- never after, because between");
            console2.log("  the two the builder would offer a step naming a token it does not touch.");
        }
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
