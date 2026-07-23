// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {IAdapter} from "../interfaces/IAdapter.sol";
import {AdapterRegistry} from "../AdapterRegistry.sol";
import {TokenAllowlist} from "../TokenAllowlist.sol";
import {Step, Policy, OpenZapIntent} from "../libraries/OpenZapTypes.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

/// @title OpenZapV2
/// @notice UNAUDITED v2 core CANDIDATE. Identical in every security property to the live v1.1
///         `OpenZap`, with exactly ONE added capability: a step may declare a **balance-relative
///         input**. Set `Step.amountIn == BALANCE_RELATIVE` (`type(uint256).max`) and, instead of
///         spending a constant frozen at signing, the step spends the zap's ENTIRE current balance of
///         `tokenIn` measured at the moment that step runs. That is what lets step k consume exactly
///         what step k-1 produced — the one thing v1 could not do, because v1's `Step.amountIn` is a
///         constant that cannot reference the previous step's output.
/// @dev This is a SEPARATE implementation and factory in `src/v2/`; nothing about the live v1.1
///      deployment changes. Deployed as an EIP-1167 clone of one hardened implementation (ADR-0002).
///      The clone holds the user's funds and a frozen policy; Hermes can only submit owner-signed
///      intents that match that policy exactly, with zero discretion.
///
///      The balance-relative mode removes a per-step *amount* bound and NO other bound. Every field
///      that grants the submitter optionality is still bound by the owner's EIP-712 signature; the
///      adapter allowlist + fixed-selector surface is unchanged; exact approvals are still reset to
///      zero on every path; single-asset settlement is unchanged; and — this is the crux — the
///      owner-signed `minOut` on the FINAL output still floors the whole chain. With per-step amounts
///      no longer fixed, that final floor is doing more of the work, so it is enforced exactly as in
///      v1. See `src/v2/README.md` for the full security argument.
///
///      Shared, cross-clone configuration (FACTORY, ADAPTERS, TOKENS) lives in implementation
///      immutables. Per-clone configuration lives in storage, written exactly once by `initialize`.
///      The implementation itself is locked at construction so it can never be initialized or hold
///      funds (invariant I-ISO-1). There is NO `selfdestruct`, NO `delegatecall`, and NO upgrade path
///      (invariant I-ISO-2).
contract OpenZapV2 {
    using SafeApprove for address;

    // --------------------------------------------------------------------- //
    // Shared immutables (identical for every clone)                          //
    // --------------------------------------------------------------------- //
    address public immutable FACTORY;
    AdapterRegistry public immutable ADAPTERS;
    TokenAllowlist public immutable TOKENS;

    // --------------------------------------------------------------------- //
    // Per-clone storage (written once by `initialize`)                       //
    // --------------------------------------------------------------------- //
    bool private _initialized;
    uint256 private _reentry; // 0 = idle, 1 = entered
    address public owner;
    address public recipient;
    uint256 public maxRelayerFeeCap;
    bool public optimization;
    bytes32 public policyHash;
    address[] private _trackedAssets;
    Step[] private _steps;
    mapping(uint256 => bool) public nonceUsed;

    /// @notice Sentinel written into a `Step.amountIn` to request balance-relative input: "spend this
    ///         zap's entire current balance of `tokenIn` at this step". This is the ONLY value with
    ///         special meaning; every other nonzero `amountIn` is a fixed constant, exactly as in v1.
    /// @dev `type(uint256).max` is chosen because it can never be a real spendable balance (it exceeds
    ///      any ERC-20 `totalSupply`), so a fixed step can never be mistaken for a balance-relative one.
    uint256 public constant BALANCE_RELATIVE = type(uint256).max;

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "OpenZapIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address recipient,address relayer,uint256 maxRelayerFee,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    // Domain version is bumped to "2": a v2 clone lives at a different address than any v1 clone, so
    // `verifyingContract` already separates the two signing surfaces — the version bump makes that
    // separation explicit and lets tooling scope a signature to the balance-relative semantics.
    bytes32 private constant DOMAIN_NAME = keccak256("OpenZap");
    bytes32 private constant DOMAIN_VERSION = keccak256("2");
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 private constant MAX_STEPS = 16;
    uint256 private constant MAX_TRACKED = 16;

    event Initialized(address indexed owner, bytes32 policyHash);
    event Executed(uint256 indexed nonce, address indexed recipient, address outAsset, uint256 amountOut, uint256 fee);
    event EmergencyExit(address indexed owner, address indexed asset, uint256 amount);
    event NonceInvalidated(uint256 indexed nonce);

    error NotFactory();
    error AlreadyInitialized();
    error NotOwner();
    error NotOptimization();
    error ZeroRecipient();
    error ZeroOwner();
    error ZeroAddress();
    error PolicyTooLarge();
    error EmptyPolicy();
    error InvalidStep(uint256 index);
    error DuplicateTrackedAsset(address asset);
    error NativeTokenUnsupported();
    error InvalidAdapterResult(uint256 index, address tokenOut, uint256 amountOut);
    error ZeroBalanceRelativeStep(uint256 index);
    error GasLimitTooHigh();
    error AdapterNotAllowed(address adapter);
    error TokenNotAllowed(address token);
    error WrongZap();
    error WrongChain();
    error PolicyMismatch();
    error Expired();
    error NotYetValid();
    error GasPriceTooHigh();
    error FeeAboveCap();
    error WrongRecipient();
    error NonceReplay();
    error BadSignature();
    error MinOutNotMet();
    error Reentrancy();
    error NativeExitFailed();

    modifier nonReentrant() {
        if (_reentry == 1) revert Reentrancy();
        _reentry = 1;
        _;
        _reentry = 0;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Deployed once by the factory. Locks the implementation against initialization so the
    ///      shared logic contract can never own funds or a policy (invariant I-ISO-1).
    constructor(address factory_, AdapterRegistry adapters_, TokenAllowlist tokens_) {
        if (factory_ == address(0) || address(adapters_) == address(0) || address(tokens_) == address(0)) {
            revert ZeroAddress();
        }
        FACTORY = factory_;
        ADAPTERS = adapters_;
        TOKENS = tokens_;
        _initialized = true; // brick the implementation; only clones get a fresh (false) slot
    }

    // --------------------------------------------------------------------- //
    // Initialization (factory-only, atomic, once)                            //
    // --------------------------------------------------------------------- //

    /// @notice Freeze this clone's policy. Callable only by the factory, exactly once, atomically
    ///         with deployment (invariant I-ISO-3) — closing the clone-init front-running window.
    function initialize(Policy calldata p) external {
        if (msg.sender != FACTORY) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        if (!p.optimization) revert NotOptimization(); // ADR-0004: v1 is optimization-only
        if (p.owner == address(0)) revert ZeroOwner(); // a zero owner would brick recovery (I-REC-1)
        if (p.recipient == address(0)) revert ZeroRecipient();
        if (p.steps.length == 0) revert EmptyPolicy();
        if (p.steps.length > MAX_STEPS || p.trackedAssets.length > MAX_TRACKED) revert PolicyTooLarge();

        owner = p.owner;
        recipient = p.recipient;
        maxRelayerFeeCap = p.maxRelayerFeeCap;
        optimization = true;

        for (uint256 i; i < p.trackedAssets.length; ++i) {
            address a = p.trackedAssets[i];
            if (!TOKENS.isAllowed(a)) revert TokenNotAllowed(a);
            for (uint256 j; j < i; ++j) {
                if (p.trackedAssets[j] == a) revert DuplicateTrackedAsset(a);
            }
            _trackedAssets.push(a);
        }
        for (uint256 i; i < p.steps.length; ++i) {
            Step calldata s = p.steps[i];
            if (s.tokenIn == address(0)) revert NativeTokenUnsupported();
            // `amountIn == 0` is still rejected. `amountIn == BALANCE_RELATIVE` (type(uint256).max) is
            // the one permitted sentinel: it is nonzero, so it clears this guard, and is resolved to a
            // live balance at execution. Every other value is a fixed constant, exactly as in v1.
            if (s.amountIn == 0) revert InvalidStep(i);
            if (!ADAPTERS.isAllowed(s.adapter)) revert AdapterNotAllowed(s.adapter);
            if (s.spender != s.adapter) revert InvalidStep(i);
            if (!TOKENS.isAllowed(s.tokenIn)) revert TokenNotAllowed(s.tokenIn);
            _steps.push();
            Step storage d = _steps[i];
            d.adapter = s.adapter;
            d.tokenIn = s.tokenIn;
            d.spender = s.spender;
            d.amountIn = s.amountIn;
            d.data = s.data;
        }

        policyHash = keccak256(abi.encode(p));
        emit Initialized(p.owner, policyHash);
    }

    // --------------------------------------------------------------------- //
    // Execution                                                              //
    // --------------------------------------------------------------------- //

    /// @notice Execute the frozen action graph under an owner-signed intent. Submitted by Hermes/a
    ///         relayer, which has zero discretion: every authority-bearing field is checked against
    ///         the frozen policy and the signature before any external call.
    function execute(OpenZapIntent calldata intent, bytes calldata sig) external nonReentrant {
        // ---- verify & consume authorization BEFORE any external call (I-AUTH-1) ----
        if (intent.zap != address(this)) revert WrongZap();
        if (intent.chainId != block.chainid) revert WrongChain();
        if (intent.policyHash != policyHash) revert PolicyMismatch(); // no submitter policy (I-AUTH-3)
        if (block.timestamp > intent.deadline) revert Expired();
        if (block.timestamp < intent.validAfter) revert NotYetValid();
        if (tx.gasprice > intent.maxFeePerGas) revert GasPriceTooHigh(); // gas-griefing guard (I-AUTH-4)
        if (intent.recipient != recipient) revert WrongRecipient();
        if (intent.maxRelayerFee > maxRelayerFeeCap) revert FeeAboveCap();
        if (gasleft() > intent.maxGas) revert GasLimitTooHigh(); // bound submitter-supplied gas (I-AUTH-4)
        if (!TOKENS.isAllowed(intent.outAsset)) revert TokenNotAllowed(intent.outAsset); // curated set (I-TOK-1)
        if (nonceUsed[intent.nonce]) revert NonceReplay();
        nonceUsed[intent.nonce] = true; // consume first (I-AUTH-1, I-AUTH-2)
        _verifySignature(intent, sig);

        // Snapshot the output asset BEFORE the loop so settlement uses only THIS run's delta, never a
        // standing balance, dust, or a mid-loop deposit (I-FLOW-4 / I-TOK-2).
        uint256 preOut = IERC20(intent.outAsset).balanceOf(address(this));

        // ---- run frozen steps: resolve amount, exact-approve, fixed-adapter call, reset (I-APPR-1/2, I-SURF-1) ----
        uint256 n = _steps.length;
        for (uint256 i; i < n; ++i) {
            Step storage s = _steps[i];
            // Re-check the registry at execution: a de-allowlisted (compromised) adapter halts the
            // zap, leaving only the unconditional emergencyExit — the governance kill-switch.
            if (!ADAPTERS.isAllowed(s.adapter)) revert AdapterNotAllowed(s.adapter);

            // Resolve this step's input amount — the ONE behaviour V2 adds over v1.
            //   * A fixed step spends the constant frozen into the policy at creation (v1 behaviour).
            //   * A balance-relative step (amountIn == BALANCE_RELATIVE) spends the zap's ENTIRE
            //     current balance of `tokenIn`, measured HERE — after every prior step has settled its
            //     output into this contract — so step k can consume exactly what step k-1 produced,
            //     with zero stranding.
            // This removes the per-step amount bound and NOTHING else: the adapter, spender, and frozen
            // `data` are unchanged, the approval below is still exact and reset to zero, and the
            // owner-signed `minOut` on the final outAsset still floors the whole chain (see settlement).
            uint256 amountIn = s.amountIn;
            if (amountIn == BALANCE_RELATIVE) {
                amountIn = IERC20(s.tokenIn).balanceOf(address(this));
                // Fail closed: a balance-relative step over an empty balance is a malformed run, not a
                // silent no-op. Reverting here also stops it degrading into an opaque
                // InvalidAdapterResult after a zero-amount adapter call.
                if (amountIn == 0) revert ZeroBalanceRelativeStep(i);
            }

            if (s.tokenIn != address(0)) s.tokenIn.approveExact(s.spender, amountIn);
            (address adapterOut, uint256 adapterAmountOut) = IAdapter(s.adapter).execute(s.tokenIn, amountIn, s.data);
            s.tokenIn.approveExact(s.spender, 0);
            if (adapterOut == address(0) || adapterAmountOut == 0 || !TOKENS.isAllowed(adapterOut)) {
                revert InvalidAdapterResult(i, adapterOut, adapterAmountOut);
            }
        }

        // ---- postconditions & settlement: measured delta only, never the absolute balance (I-FLOW-1/2/4) ----
        // This is unchanged from v1 and is what makes balance-relative safe: no matter how the
        // per-step amounts were resolved, the ONLY value that can leave this contract is `out` (the
        // measured gain in outAsset) to the recipient plus a capped fee to the relayer, and `out` must
        // clear the owner-signed `minOut`.
        uint256 out = IERC20(intent.outAsset).balanceOf(address(this)) - preOut; // underflow-reverts if no gain
        uint256 fee = 0;
        if (intent.maxRelayerFee != 0 && intent.relayer != address(0)) {
            fee = intent.maxRelayerFee;
            if (fee > out) fee = out;
            if (out - fee < intent.minOut) revert MinOutNotMet(); // net-of-fee min-out (I-FLOW-2)
            out -= fee;
            intent.outAsset.safeTransfer(intent.relayer, fee);
        } else {
            if (out < intent.minOut) revert MinOutNotMet();
        }
        intent.outAsset.safeTransfer(recipient, out);
        emit Executed(intent.nonce, recipient, intent.outAsset, out, fee);
    }

    // --------------------------------------------------------------------- //
    // Recovery & revocation (always available to the owner)                  //
    // --------------------------------------------------------------------- //

    /// @notice Unconditional, owner-only drain of arbitrary assets to the owner (invariant I-REC-1).
    /// @dev Routes through NO adapter (I-REC-2). Works regardless of adapter health, Hermes liveness,
    ///      registry state, or postconditions — because immutable zaps call mutable protocols and
    ///      there is no admin on instances, this is the only recovery path (eval Gap 2).
    function emergencyExit(address[] calldata assets) external onlyOwner {
        for (uint256 i; i < assets.length; ++i) {
            address a = assets[i];
            uint256 bal = IERC20(a).balanceOf(address(this));
            if (bal != 0) {
                a.safeTransfer(owner, bal);
                emit EmergencyExit(owner, a, bal);
            }
        }
        uint256 nativeBal = address(this).balance;
        if (nativeBal != 0) {
            (bool ok,) = payable(owner).call{value: nativeBal}("");
            if (!ok) revert NativeExitFailed();
            emit EmergencyExit(owner, address(0), nativeBal);
        }
    }

    /// @notice Invalidate a nonce off the fast path, so a held intent can never be submitted (I-REC-3).
    function invalidateNonce(uint256 nonce) external onlyOwner {
        nonceUsed[nonce] = true;
        emit NonceInvalidated(nonce);
    }

    // --------------------------------------------------------------------- //
    // Signature verification (EIP-712 + ERC-1271)                            //
    // --------------------------------------------------------------------- //

    /// @dev Domain separator is recomputed from `block.chainid` every call — never cached — so a
    ///      post-fork chain cannot reuse a stale separator (invariant I-AUTH-5).
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME, DOMAIN_VERSION, block.chainid, address(this)));
    }

    function hashIntent(OpenZapIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.zap,
                intent.chainId,
                intent.nonce,
                intent.validAfter,
                intent.deadline,
                intent.recipient,
                intent.relayer,
                intent.maxRelayerFee,
                intent.maxGas,
                intent.maxFeePerGas,
                intent.policyHash,
                intent.outAsset,
                intent.minOut
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _verifySignature(OpenZapIntent calldata intent, bytes calldata sig) private view {
        bytes32 digest = hashIntent(intent);
        address o = owner;
        if (o.code.length != 0) {
            // ERC-1271 contract wallet (e.g. Safe)
            (bool ok, bytes memory ret) = o.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, digest, sig));
            if (!(ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == ERC1271_MAGIC)) revert BadSignature();
        } else {
            address rec = _recover(digest, sig);
            if (rec == address(0) || rec != o) revert BadSignature(); // never accept the zero address
        }
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_N) return address(0); // malleability guard
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // --------------------------------------------------------------------- //
    // Views                                                                  //
    // --------------------------------------------------------------------- //

    function stepCount() external view returns (uint256) {
        return _steps.length;
    }

    function trackedAssets() external view returns (address[] memory) {
        return _trackedAssets;
    }

    function step(uint256 i) external view returns (Step memory) {
        return _steps[i];
    }

    receive() external payable {} // accept native deposits/refunds; NEVER triggers execution (eval Gap 7)
}
