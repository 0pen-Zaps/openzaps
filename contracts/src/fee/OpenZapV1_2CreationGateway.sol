// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {IAdapter} from "../interfaces/IAdapter.sol";
import {Policy} from "../libraries/OpenZapTypes.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {ZapCreationFeePot} from "./ZapCreationFeePot.sol";

interface IV1_2GatewayAeWETH {
    function deposit() external payable;
}

interface IV1_2FactoryLike {
    function createZap(Policy calldata p, bytes32 salt) external returns (address zap);
    function predict(Policy calldata p, bytes32 salt) external view returns (address zap);
}

/// @title OpenZapV1_2CreationGateway
/// @notice Exact-fee creation gateway for the isolated v1.2 halt + Permit2 lineage. The gateway can
///         call one immutable factory and no other target. Every successful creation wraps the exact
///         native fee, converts it through one immutable aeWETH -> 0xZAPS adapter, and credits a
///         dedicated no-drain creation pot to the policy owner.
/// @dev The live v1.1/v3/v3.1 creation gateway and its active prize round remain untouched. This
///      contract creates and binds its own `ZapCreationFeePot` inside the constructor, eliminating
///      any public interval in which an unbound pot could be claimed or misconfigured. If any
///      constructor check or binding call fails, deployment of both contracts rolls back atomically.
contract OpenZapV1_2CreationGateway {
    using SafeApprove for address;

    string public constant VERSION = "1.0.0-candidate";

    address public immutable V1_2_FACTORY;
    address public immutable AEWETH;
    address public immutable ZAPS;
    address public immutable CREATION_ADAPTER;
    uint256 public immutable CREATION_FEE;
    ZapCreationFeePot public immutable CREATION_POT;

    uint256 private _entered;

    event V1_2CreationFeeConverted(
        address indexed zap, address indexed owner, address indexed factory, uint256 nativeAmount, uint256 zapsOut
    );

    error ZeroAddress();
    error AddressHasNoCode(address target);
    error ZeroCreationFee();
    error PotConfigMismatch();
    error IncorrectCreationFee(uint256 got, uint256 want);
    error ZeroMinZapsOut();
    error PredictedZapMismatch(address predicted, address created);
    error CreatedZapHasNoCode(address zap);
    error WrongAdapterOutput(address tokenOut);
    error MinZapsNotMet(uint256 got, uint256 want);
    error InexactWrappedAmount(uint256 got, uint256 want);
    error InexactInputSpent(uint256 got, uint256 want);
    error InexactPotTransfer(uint256 got, uint256 want);
    error Reentrancy();

    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    function _nonReentrantBefore() private {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
    }

    function _nonReentrantAfter() private {
        _entered = 0;
    }

    constructor(
        address governance_,
        address v12Factory_,
        address aeWeth_,
        address zaps_,
        address creationAdapter_,
        uint256 creationFee_
    ) {
        if (
            governance_ == address(0) || v12Factory_ == address(0) || aeWeth_ == address(0) || zaps_ == address(0)
                || creationAdapter_ == address(0)
        ) revert ZeroAddress();
        _requireCode(v12Factory_);
        _requireCode(aeWeth_);
        _requireCode(zaps_);
        _requireCode(creationAdapter_);
        if (creationFee_ == 0) revert ZeroCreationFee();

        V1_2_FACTORY = v12Factory_;
        AEWETH = aeWeth_;
        ZAPS = zaps_;
        CREATION_ADAPTER = creationAdapter_;
        CREATION_FEE = creationFee_;

        ZapCreationFeePot creationPot = new ZapCreationFeePot(governance_, zaps_);
        creationPot.setGateway(address(this));
        if (
            creationPot.owner() != governance_ || creationPot.pendingOwner() != address(0)
                || creationPot.ZAPS() != zaps_ || creationPot.gateway() != address(this)
                || creationPot.gatewayInstaller() != address(0)
        ) revert PotConfigMismatch();
        CREATION_POT = creationPot;
    }

    /// @notice Create a v1.2 capsule and atomically convert the exact app fee.
    /// @param minZapsOut Caller-reviewed minimum 0xZAPS output for the immutable conversion route.
    function createZap(Policy calldata p, bytes32 salt, uint256 minZapsOut)
        external
        payable
        nonReentrant
        returns (address zap)
    {
        if (msg.value != CREATION_FEE) revert IncorrectCreationFee(msg.value, CREATION_FEE);
        if (minZapsOut == 0) revert ZeroMinZapsOut();

        address predicted = IV1_2FactoryLike(V1_2_FACTORY).predict(p, salt);
        zap = IV1_2FactoryLike(V1_2_FACTORY).createZap(p, salt);
        if (zap != predicted) revert PredictedZapMismatch(predicted, zap);
        if (zap.code.length == 0) revert CreatedZapHasNoCode(zap);

        uint256 preWeth = IERC20(AEWETH).balanceOf(address(this));
        IV1_2GatewayAeWETH(AEWETH).deposit{value: msg.value}();
        uint256 wrapped = IERC20(AEWETH).balanceOf(address(this)) - preWeth;
        if (wrapped != CREATION_FEE) revert InexactWrappedAmount(wrapped, CREATION_FEE);

        uint256 preZaps = IERC20(ZAPS).balanceOf(address(this));
        AEWETH.approveExact(CREATION_ADAPTER, wrapped);
        (address tokenOut,) = IAdapter(CREATION_ADAPTER).execute(AEWETH, wrapped, "");
        AEWETH.approveExact(CREATION_ADAPTER, 0);
        if (tokenOut != ZAPS) revert WrongAdapterOutput(tokenOut);

        uint256 postWeth = IERC20(AEWETH).balanceOf(address(this));
        uint256 spent = preWeth + wrapped - postWeth;
        if (spent != wrapped) revert InexactInputSpent(spent, wrapped);

        uint256 zapsOut = IERC20(ZAPS).balanceOf(address(this)) - preZaps;
        if (zapsOut == 0 || zapsOut < minZapsOut) revert MinZapsNotMet(zapsOut, minZapsOut);

        uint256 prePotZaps = IERC20(ZAPS).balanceOf(address(CREATION_POT));
        ZAPS.safeTransfer(address(CREATION_POT), zapsOut);
        uint256 received = IERC20(ZAPS).balanceOf(address(CREATION_POT)) - prePotZaps;
        if (received != zapsOut) revert InexactPotTransfer(received, zapsOut);
        CREATION_POT.recordCreation(p.owner, zap, zapsOut);

        emit V1_2CreationFeeConverted(zap, p.owner, V1_2_FACTORY, msg.value, zapsOut);
    }

    function predict(Policy calldata p, bytes32 salt) external view returns (address) {
        return IV1_2FactoryLike(V1_2_FACTORY).predict(p, salt);
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert AddressHasNoCode(target);
    }
}
