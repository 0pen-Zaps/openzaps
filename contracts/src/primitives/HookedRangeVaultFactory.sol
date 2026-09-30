// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {HookedRangeVault} from "./HookedRangeVault.sol";

interface IERC20Symbol {
    function symbol() external view returns (string memory);
}

/// @dev The slice of a Hookr market coordinator (Modular V2 and V3 share it) this factory reads:
///      the recorded market for a pool id, whose `kernel` is the hook in that pool's key.
interface IHookrMarketCoordinatorRecord {
    struct Market {
        bool live;
        uint8 origin;
        address subject;
        address quote;
        address creator;
        address kernel;
        address revenueVault;
        address lpFeeRecipient;
        bytes32 kernelId;
        bytes32 stackHash;
        bytes32 poolId;
        uint160 sqrtPriceX96;
        int24 tickSpacing;
        uint256 subjectSupplied;
        uint256 quoteSupplied;
        uint256 subjectUsed;
        uint256 quoteUsed;
        uint256 cumulativeFee0;
        uint256 cumulativeFee1;
        uint256 openedAtBlock;
        bytes32 launchIntentId;
        address initialBuyRouter;
        uint256 creatorAllocation;
        uint256 initialBuyQuoteIn;
        uint256 initialBuySubjectOut;
        uint256 initialBuySubjectOutMinimum;
        bytes32 initialBuyModuleDataHash;
    }

    function getMarket(bytes32 poolId) external view returns (Market memory market);
}

/// @title HookedRangeVaultFactory
/// @notice Permissionless, deterministic deployment of one `HookedRangeVault` per pool for every
///         pool that (a) lives on the pinned PoolManager, (b) carries an ADMITTED hook, and (c) is
///         quoted in native ETH or in the pinned quote token. A hook is admitted two ways:
///           - it is one of the hooks pinned at construction (Hookr V5's shared launchpad hook,
///             Modular V2's shared `HookrSwapKernelV1`), or
///           - one of the pinned Hookr market coordinators records a LIVE market for exactly this
///             pool id whose `kernel` is this hook. That is how Hookr Modular V3 works: every market
///             gets its own factory-attested hook INSTANCE address, so no static list can name them;
///             the coordinator's own market registry is the authority on which hook a pool binds.
///         On Robinhood Chain that is "every pool any Hookr generation graduates". A new launch
///         needs no OpenZaps deployment: anyone can call `createVault` for it and the result is the
///         same address for everyone.
///
/// @dev WHY A FACTORY. The universal deposit/withdraw adapters accept a vault address in their
///      step data. Arbitrary targets in step data are exactly what the OpenZap model refuses, so
///      the adapters only honour vaults THIS factory deployed (`isVault`). The factory therefore
///      IS the bound: a vault can only exist for a pool with a pinned hook and an admitted quote,
///      and its bytecode is this repository's `HookedRangeVault`, nothing else.
///
///      NO ADMIN. The allowed-hook set is fixed at construction. Each hook's own admission
///      control (V5: launchpad-configured pools only; V2: coordinator-initialized markets only)
///      plus the vault constructor's permission-bit vetting decide what can exist. What the
///      factory cannot vouch for is the TOKEN side of a launch — a fresh contract per launch,
///      exactly as trustworthy as its deployer. The share token is still subject to the OpenZap
///      `TokenAllowlist` at capsule creation, which remains the governance gate.
///
///      CREATE2 with `salt = poolId` so `vaultFor` can be predicted off-chain before creation.
contract HookedRangeVaultFactory {
    address public immutable poolManager;
    /// @notice Wrapped native ERC-20 handed to native-quoted vaults as their currency0 face.
    address public immutable weth;
    /// @notice The ERC-20 quote token admitted on one side of a pool (HOOKR on Robinhood Chain).
    address public immutable quote;

    mapping(address => bool) public isAllowedHook;
    address[] private _allowedHooks;
    /// @notice Hookr market coordinators whose live market records admit per-market hook instances.
    address[] private _coordinators;

    mapping(bytes32 => address) public vaultOf;
    mapping(address => bool) public isVault;
    address[] private _vaults;

    event VaultCreated(
        bytes32 indexed poolId,
        address indexed vault,
        address currency0,
        address currency1,
        uint24 fee,
        int24 tickSpacing,
        address hooks
    );

    error ZeroAddress();
    error NoCode(address target);
    error NoHooks();
    error DuplicateHook(address hooks);
    error HookNotAllowed(address hooks);
    error DuplicateCoordinator(address coordinator);
    error QuoteNotInPool(address currency0, address currency1);
    error VaultExists(bytes32 poolId, address vault);
    error VaultAddressMismatch(address expected, address actual);

    constructor(
        address poolManager_,
        address weth_,
        address quote_,
        address[] memory hooks_,
        address[] memory coordinators_
    ) {
        if (poolManager_ == address(0) || weth_ == address(0) || quote_ == address(0)) {
            revert ZeroAddress();
        }
        if (hooks_.length == 0 && coordinators_.length == 0) revert NoHooks();
        for (uint256 i = 0; i < coordinators_.length; i++) {
            address coordinator = coordinators_[i];
            if (coordinator == address(0)) revert ZeroAddress();
            _requireCode(coordinator);
            for (uint256 j = 0; j < i; j++) {
                if (coordinators_[j] == coordinator) revert DuplicateCoordinator(coordinator);
            }
            _coordinators.push(coordinator);
        }
        _requireCode(poolManager_);
        _requireCode(weth_);
        _requireCode(quote_);
        for (uint256 i = 0; i < hooks_.length; i++) {
            address hook = hooks_[i];
            if (hook == address(0)) revert ZeroAddress();
            if (isAllowedHook[hook]) revert DuplicateHook(hook);
            _requireCode(hook);
            isAllowedHook[hook] = true;
            _allowedHooks.push(hook);
        }
        poolManager = poolManager_;
        weth = weth_;
        quote = quote_;
    }

    /// @notice Deploy the vault for `(currency0, currency1, fee, tickSpacing, hooks)`. `currency0`
    ///         may be `address(0)` (native quote). Reverts if one already exists, if the hook is not
    ///         pinned, if neither native nor `quote` is on a side, or — through the vault's own
    ///         constructor — if the pool is not initialized, the currencies are unsorted, or the
    ///         hook's permission bits are refused.
    function createVault(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)
        external
        returns (address vault)
    {
        if (currency0 != address(0) && currency0 != quote && currency1 != quote) {
            revert QuoteNotInPool(currency0, currency1);
        }
        bytes32 poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks));
        if (!isAllowedHook[hooks] && !_coordinatorAttests(poolId, hooks)) revert HookNotAllowed(hooks);
        if (vaultOf[poolId] != address(0)) revert VaultExists(poolId, vaultOf[poolId]);

        (string memory name, string memory symbol) = _shareNames(currency0, currency1);
        address predicted = vaultFor(currency0, currency1, fee, tickSpacing, hooks);
        vault = address(
            new HookedRangeVault{salt: poolId}(
                poolManager, weth, currency0, currency1, fee, tickSpacing, hooks, name, symbol
            )
        );
        if (vault != predicted) revert VaultAddressMismatch(predicted, vault);

        vaultOf[poolId] = vault;
        isVault[vault] = true;
        _vaults.push(vault);
        emit VaultCreated(poolId, vault, currency0, currency1, fee, tickSpacing, hooks);
    }

    /// @notice The address `createVault` will (or did) produce for this key.
    function vaultFor(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)
        public
        view
        returns (address)
    {
        bytes32 poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks));
        (string memory name, string memory symbol) = _shareNames(currency0, currency1);
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(HookedRangeVault).creationCode,
                abi.encode(poolManager, weth, currency0, currency1, fee, tickSpacing, hooks, name, symbol)
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), poolId, initCodeHash)))));
    }

    function allowedHooks() external view returns (address[] memory) {
        return _allowedHooks;
    }

    function coordinators() external view returns (address[] memory) {
        return _coordinators;
    }

    /// @notice Whether a pinned coordinator records a live market for `poolId` bound to `hooks`.
    function coordinatorAttests(bytes32 poolId, address hooks) external view returns (bool) {
        return _coordinatorAttests(poolId, hooks);
    }

    /// @dev A market record is trusted only when it is live, names exactly this pool id, and binds
    ///      exactly this hook; the coordinator itself is the immutable authority pinned here.
    function _coordinatorAttests(bytes32 poolId, address hooks) private view returns (bool) {
        for (uint256 i = 0; i < _coordinators.length; i++) {
            IHookrMarketCoordinatorRecord.Market memory market =
                IHookrMarketCoordinatorRecord(_coordinators[i]).getMarket(poolId);
            if (market.live && market.poolId == poolId && market.kernel == hooks && hooks != address(0)) return true;
        }
        return false;
    }

    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    function vaultAt(uint256 index) external view returns (address) {
        return _vaults[index];
    }

    function vaults() external view returns (address[] memory) {
        return _vaults;
    }

    /// @dev Share names come from the pool tokens' own `symbol()` ("ETH" for native); a token
    ///      without one is named by its address. Names are cosmetic — identity is the pool id.
    function _shareNames(address currency0, address currency1)
        private
        view
        returns (string memory name, string memory symbol)
    {
        string memory s0 = currency0 == address(0) ? "ETH" : _symbolOf(currency0);
        string memory s1 = _symbolOf(currency1);
        name = string.concat("OpenZap Hooked Range ", s0, "/", s1);
        symbol = string.concat("ozHR-", s0, "-", s1);
    }

    function _symbolOf(address token) private view returns (string memory) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IERC20Symbol.symbol, ()));
        if (ok && ret.length >= 64) {
            string memory decoded = abi.decode(ret, (string));
            if (bytes(decoded).length != 0 && bytes(decoded).length <= 32) return decoded;
        }
        return _hex(token);
    }

    function _hex(address value) private pure returns (string memory) {
        bytes16 alphabet = "0123456789abcdef";
        bytes memory out = new bytes(10);
        out[0] = "0";
        out[1] = "x";
        uint160 v = uint160(value) >> 128;
        for (uint256 i = 0; i < 8; i++) {
            out[9 - i] = alphabet[v & 0xf];
            v >>= 4;
        }
        return string(out);
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert NoCode(target);
    }
}
