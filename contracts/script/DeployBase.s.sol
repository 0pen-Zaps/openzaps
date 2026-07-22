// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {BaseV3SwapAdapter} from "../src/adapters/BaseV3SwapAdapter.sol";
import {AaveV3SupplyAdapter} from "../src/adapters/AaveV3SupplyAdapter.sol";

/// @title DeployBase
/// @notice Deploys a COMPLETE, FRESH OpenZap v1.1 set to Base mainnet (8453): registry, allowlist,
///         factory (which deploys the implementation in its own constructor), and every adapter that
///         actually shipped — then allowlists those adapters and the tokens they move.
///
/// @dev THE EXISTING BASE ADDRESSES ARE STALE. There is an older deployment on Base whose factory is
///      0xc7C5897e4738a157731c2F93b1d73Db9926E926C and whose `VERSION()` reads "1.0.0". This script
///      does NOT touch, reuse, or upgrade it — OpenZap has no upgrade path by design (I-ISO-2), so a
///      new core version is always a new deployment. Anything produced by this script is a brand new
///      v1.1.0 set with new addresses, and the 1.0.0 addresses must not be quoted as current.
///
///      NOT IDEMPOTENT, on purpose. Every run deploys a new registry, a new allowlist, a new factory
///      and new adapters. Running it twice does not converge on one deployment; it gives you two,
///      and the second one's zaps are invisible to the first one's governance. Run it exactly once
///      per environment and record the addresses it prints. To add an adapter later, deploy that
///      adapter alone and have governance call `AdapterRegistry.setAdapter` — do not re-run this.
///
///      NO KEY MATERIAL. This script contains no private key, no mnemonic and no hardcoded deployer,
///      and it never reads one from the environment. `vm.startBroadcast()` takes no argument, so the
///      signer comes from the forge CLI (`--ledger`, `--trezor`, `--account`, `--interactive`, or an
///      external signer) and the deployer address is whatever `--sender` names. `GOVERNANCE` is read
///      with `vm.envAddress`-style lookup (`vm.envOr`) and is an ADDRESS, never a key.
///
///      GOVERNANCE HANDOFF IS TWO-STEP. The deployer must own the registry and the allowlist while
///      this script configures them, so it deploys them to itself and then *proposes* ownership to
///      `GOVERNANCE`. Until the Safe calls `acceptOwnership()` on BOTH contracts, the deployer is
///      still the kill-switch holder. That acceptance is a separate, human step — see the console
///      output at the end of the run.
///
///      WHAT IT DELIBERATELY DOES NOT DEPLOY:
///      - No borrow adapter. `src/adapters/AaveV3BorrowAdapter.sol` compiles to nothing on purpose;
///        a borrow leg cannot be expressed under `IAdapter` (see that file and its fork tests).
///      - No wrap/unwrap adapter. Neither direction is a legal step under this core; the front end
///        wraps in the user's own wallet before funding a capsule.
///      - No LP, bridge, split or loop adapter. See BASE_CAPABILITIES.md for exactly why each of
///        those cannot settle under `out = balanceOf(outAsset) - preOut`.
contract DeployBase is Script {
    uint256 internal constant BASE_CHAIN_ID = 8453;

    /// @dev The superseded v1.0.0 factory on Base. Recorded here so nobody mistakes it for current.
    ///      This script never reads or writes it.
    address internal constant STALE_V1_0_0_FACTORY = 0xc7C5897e4738a157731c2F93b1d73Db9926E926C;

    // --- protocol addresses, each verified against Base mainnet by bytecode probe --------------- //
    /// @dev Uniswap SwapRouter02. Its `factory()` returns V3_FACTORY; asserted below, not assumed.
    address internal constant SWAP_ROUTER_02 = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @dev 0.05% tier. WETH sorts strictly below USDC on Base, which the adapter's constructor
    ///      requires (`tokenA_ < tokenB_`).
    uint24 internal constant FEE_500 = 500;
    /// @dev The pool the swap adapter must resolve to, from the router's own factory.
    address internal constant EXPECTED_WETH_USDC_500_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;

    /// @dev Guards against deploying a stale artifact: this script is only correct for the v1.1 core.
    string internal constant EXPECTED_VERSION = "1.1.0";

    error WrongChain(uint256 actual);
    error MissingCode(address target);
    error ZeroGovernance();
    error UnexpectedRouterFactory(address actual);
    error UnexpectedCoreVersion(string actual);
    error DeploymentAssertionFailed();

    function run()
        external
        returns (
            AdapterRegistry registry,
            TokenAllowlist allowlist,
            OpenZapFactory factory,
            BaseV3SwapAdapter swapAdapter,
            AaveV3SupplyAdapter supplyAdapter
        )
    {
        // ---- preflight: refuse to deploy anywhere but Base, against anything but real code ------ //
        if (block.chainid != BASE_CHAIN_ID) revert WrongChain(block.chainid);
        _requireCode(SWAP_ROUTER_02);
        _requireCode(V3_FACTORY);
        _requireCode(AAVE_V3_POOL);
        _requireCode(WETH);
        _requireCode(USDC);
        _requireCode(EXPECTED_WETH_USDC_500_POOL);

        // The router must be wired to the factory we think it is; the adapter resolves its pool
        // through `swapRouter.factory()`, so a different factory silently means a different pool.
        address routerFactory = IUniswapV3SwapRouter02Minimal(SWAP_ROUTER_02).factory();
        if (routerFactory != V3_FACTORY) revert UnexpectedRouterFactory(routerFactory);

        address deployer = msg.sender; // from --sender / the configured signer; never a key in here
        address governance = vm.envOr("GOVERNANCE", deployer);
        if (governance == address(0)) revert ZeroGovernance();

        // ---- deploy ----------------------------------------------------------------------------- //
        vm.startBroadcast();

        // Governance first, owned by the deployer for the duration of this script only.
        registry = new AdapterRegistry(deployer);
        allowlist = new TokenAllowlist(deployer);

        // The factory deploys the OpenZap implementation in its own constructor and pins itself as
        // that implementation's sole initializer.
        factory = new OpenZapFactory(registry, allowlist);

        // Adapters. One instance == one pool / one reserve == one action (invariant I-SURF-1).
        // Both constructors do their own on-chain verification and revert rather than mis-wire:
        // the swap adapter resolves its pool from the router's factory, and the supply adapter
        // resolves the reserve's aToken from the Pool and checks its UNDERLYING_ASSET_ADDRESS.
        swapAdapter = new BaseV3SwapAdapter(SWAP_ROUTER_02, WETH, USDC, FEE_500);
        supplyAdapter = new AaveV3SupplyAdapter(AAVE_V3_POOL, WETH);

        registry.setAdapter(address(swapAdapter), true);
        registry.setAdapter(address(supplyAdapter), true);

        // Tokens. WETH and USDC are the swap pair and the supply reserve. aWETH must be allowlisted
        // too or `OpenZap.execute` rejects the supply step's own output with InvalidAdapterResult —
        // the adapter returns the aToken, and every step's `tokenOut` is checked against this list.
        address aWETH = supplyAdapter.aToken();
        allowlist.setToken(WETH, true);
        allowlist.setToken(USDC, true);
        allowlist.setToken(aWETH, true);

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
                || !allowlist.isAllowed(WETH) || !allowlist.isAllowed(USDC) || !allowlist.isAllowed(aWETH)
                || swapAdapter.pool() != EXPECTED_WETH_USDC_500_POOL || swapAdapter.token0() != WETH
                || swapAdapter.token1() != USDC || swapAdapter.fee() != FEE_500 || supplyAdapter.pool() != AAVE_V3_POOL
                || supplyAdapter.asset() != WETH || aWETH.code.length == 0
                || registry.pendingOwner() != (governance == deployer ? address(0) : governance)
                || allowlist.pendingOwner() != (governance == deployer ? address(0) : governance)
        ) revert DeploymentAssertionFailed();

        // ---- record ------------------------------------------------------------------------------ //
        console2.log("chain id", block.chainid);
        console2.log("block", block.number);
        console2.log("deployer", deployer);
        console2.log("governance (proposed)", governance);
        console2.log("core VERSION", factory.VERSION());
        console2.log("AdapterRegistry", address(registry));
        console2.log("TokenAllowlist", address(allowlist));
        console2.log("OpenZapFactory", address(factory));
        console2.log("OpenZap implementation", factory.implementation());
        console2.log("BaseV3SwapAdapter (WETH/USDC 0.05%)", address(swapAdapter));
        console2.log("  -> pool", swapAdapter.pool());
        console2.log("AaveV3SupplyAdapter (WETH)", address(supplyAdapter));
        console2.log("  -> aToken", aWETH);
        console2.log("allowlisted tokens: WETH", WETH);
        console2.log("allowlisted tokens: USDC", USDC);
        console2.log("allowlisted tokens: aWETH", aWETH);
        console2.log("superseded v1.0.0 factory (NOT used)", STALE_V1_0_0_FACTORY);
        if (governance != deployer) {
            console2.log("ACTION REQUIRED: governance must call acceptOwnership() on BOTH");
            console2.log("  AdapterRegistry", address(registry));
            console2.log("  TokenAllowlist", address(allowlist));
        } else {
            console2.log("WARNING: governance == deployer. Transfer both to a Safe before funding.");
        }
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }
}

/// @dev Local minimal view interface so the script can check the router's factory without importing
///      the adapter's internal interface. Read-only; never used to route anything.
interface IUniswapV3SwapRouter02Minimal {
    function factory() external view returns (address);
}
