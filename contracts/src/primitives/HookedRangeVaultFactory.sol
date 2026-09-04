// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {HookedRangeVault} from "./HookedRangeVault.sol";

interface IERC20Symbol {
    function symbol() external view returns (string memory);
}

/// @title HookedRangeVaultFactory
/// @notice Permissionless, deterministic deployment of one `HookedRangeVault` per pool for every
///         pool that (a) lives on the pinned PoolManager, (b) carries the pinned hook, and (c) has
///         the pinned quote token on one side. On Robinhood Chain that is "every HOOKR-quoted pool
///         the Hookr launchpad graduates": a new launch needs no OpenZaps deployment, anyone can
///         call `createVault` for it, and the result is the same address for everyone.
///
/// @dev WHY A FACTORY. The universal deposit/withdraw adapters accept a vault address in their
///      step data. Arbitrary targets in step data are exactly what the OpenZap model refuses, so
///      the adapters only honour vaults THIS factory deployed (`isVault`). The factory therefore
///      IS the bound: a vault can only exist for a pool with the pinned hook and quote token, and
///      its bytecode is this repository's `HookedRangeVault`, nothing else.
///
///      NO ADMIN. No owner, no pause, no allowlist of tokens: the launchpad's own hook is the
///      admission control (its `beforeInitialize` refuses pools it did not configure), and the
///      vault's constructor vets the hook's permission bits. What the factory cannot vouch for is
///      the TOKEN side of a launch — that is a fresh contract per launch and is exactly as
///      trustworthy as its deployer. The share token is still subject to the OpenZap
///      `TokenAllowlist` at capsule creation, which remains the governance gate.
///
///      CREATE2 with `salt = poolId` so `vaultFor` can be predicted off-chain before creation.
contract HookedRangeVaultFactory {
    address public immutable poolManager;
    /// @notice The single hook every vault from this factory is pinned to.
    address public immutable hooks;
    /// @notice The token that must be on one side of every pool (HOOKR on Robinhood Chain).
    address public immutable quote;

    mapping(bytes32 => address) public vaultOf;
    mapping(address => bool) public isVault;
    address[] private _vaults;

    event VaultCreated(
        bytes32 indexed poolId,
        address indexed vault,
        address currency0,
        address currency1,
        uint24 fee,
        int24 tickSpacing
    );

    error ZeroAddress();
    error NoCode(address target);
    error QuoteNotInPool(address currency0, address currency1);
    error VaultExists(bytes32 poolId, address vault);
    error VaultAddressMismatch(address expected, address actual);

    constructor(address poolManager_, address hooks_, address quote_) {
        if (poolManager_ == address(0) || hooks_ == address(0) || quote_ == address(0)) revert ZeroAddress();
        _requireCode(poolManager_);
        _requireCode(hooks_);
        _requireCode(quote_);
        poolManager = poolManager_;
        hooks = hooks_;
        quote = quote_;
    }

    /// @notice Deploy the vault for `(currency0, currency1, fee, tickSpacing, hooks)`. Reverts if
    ///         one already exists, if `quote` is on neither side, or — through the vault's own
    ///         constructor — if the pool is not initialized or the currencies are unsorted.
    function createVault(address currency0, address currency1, uint24 fee, int24 tickSpacing)
        external
        returns (address vault)
    {
        if (currency0 != quote && currency1 != quote) revert QuoteNotInPool(currency0, currency1);
        bytes32 poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks));
        if (vaultOf[poolId] != address(0)) revert VaultExists(poolId, vaultOf[poolId]);

        (string memory name, string memory symbol) = _shareNames(currency0, currency1);
        address predicted = vaultFor(currency0, currency1, fee, tickSpacing);
        vault = address(
            new HookedRangeVault{salt: poolId}(
                poolManager, currency0, currency1, fee, tickSpacing, hooks, name, symbol
            )
        );
        if (vault != predicted) revert VaultAddressMismatch(predicted, vault);

        vaultOf[poolId] = vault;
        isVault[vault] = true;
        _vaults.push(vault);
        emit VaultCreated(poolId, vault, currency0, currency1, fee, tickSpacing);
    }

    /// @notice The address `createVault` will (or did) produce for this key.
    function vaultFor(address currency0, address currency1, uint24 fee, int24 tickSpacing)
        public
        view
        returns (address)
    {
        bytes32 poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks));
        (string memory name, string memory symbol) = _shareNames(currency0, currency1);
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(HookedRangeVault).creationCode,
                abi.encode(poolManager, currency0, currency1, fee, tickSpacing, hooks, name, symbol)
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), poolId, initCodeHash)))));
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

    /// @dev Share names come from the pool tokens' own `symbol()`; a token without one is named by
    ///      its address. Names are cosmetic — identity is the pool id.
    function _shareNames(address currency0, address currency1)
        private
        view
        returns (string memory name, string memory symbol)
    {
        string memory s0 = _symbolOf(currency0);
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
        uint160 v = uint160(value) >> 128; // first 4 bytes
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
