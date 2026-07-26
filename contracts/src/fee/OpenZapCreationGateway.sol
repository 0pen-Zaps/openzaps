// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {IAdapter} from "../interfaces/IAdapter.sol";
import {Policy} from "../libraries/OpenZapTypes.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";
import {ZapCreationFeePot} from "./ZapCreationFeePot.sol";

interface IAeWETH {
    function deposit() external payable;
}

interface IOpenZapFactoryLike {
    function createZap(Policy calldata p, bytes32 salt) external returns (address zap);
    function predict(Policy calldata p, bytes32 salt) external view returns (address zap);
}

/// @title OpenZapCreationGateway
/// @notice Fee-enforcing gateway in front of the already-deployed v1.1, v3, and v3.1 factories.
///         Every successful app creation pays one exact native fee that is atomically wrapped to
///         aeWETH, converted through one immutable aeWETH -> 0xZAPS adapter, and credited to the
///         no-drain creation pot for the policy owner.
/// @dev The gateway does not deploy a replacement OpenZap implementation and does not alter EIP-712
///      domains, runtime bytecode, deterministic addresses, or each automation lineage's existing
///      executor-fee pot. If factory creation or fee conversion fails, the entire transaction reverts.
contract OpenZapCreationGateway {
    using SafeApprove for address;

    enum Lineage {
        OneShot,
        Trigger,
        RecurringRelative
    }

    string public constant VERSION = "1.0.0-candidate";

    address public immutable ONE_SHOT_FACTORY;
    address public immutable TRIGGER_FACTORY;
    address public immutable RECURRING_FACTORY;
    address public immutable AEWETH;
    address public immutable ZAPS;
    address public immutable CREATION_ADAPTER;
    uint256 public immutable CREATION_FEE;
    ZapCreationFeePot public immutable CREATION_POT;

    uint256 private _entered;

    event CreationFeeConverted(
        address indexed zap,
        address indexed owner,
        Lineage indexed lineage,
        address factory,
        uint256 nativeAmount,
        uint256 zapsOut
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
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(
        address oneShotFactory_,
        address triggerFactory_,
        address recurringFactory_,
        address aeWeth_,
        address zaps_,
        address creationAdapter_,
        ZapCreationFeePot creationPot_,
        uint256 creationFee_
    ) {
        if (
            oneShotFactory_ == address(0) || triggerFactory_ == address(0) || recurringFactory_ == address(0)
                || aeWeth_ == address(0) || zaps_ == address(0) || creationAdapter_ == address(0)
                || address(creationPot_) == address(0)
        ) revert ZeroAddress();
        _requireCode(oneShotFactory_);
        _requireCode(triggerFactory_);
        _requireCode(recurringFactory_);
        _requireCode(aeWeth_);
        _requireCode(zaps_);
        _requireCode(creationAdapter_);
        _requireCode(address(creationPot_));
        if (creationFee_ == 0) revert ZeroCreationFee();
        if (creationPot_.ZAPS() != zaps_ || creationPot_.gateway() != address(0)) revert PotConfigMismatch();

        ONE_SHOT_FACTORY = oneShotFactory_;
        TRIGGER_FACTORY = triggerFactory_;
        RECURRING_FACTORY = recurringFactory_;
        AEWETH = aeWeth_;
        ZAPS = zaps_;
        CREATION_ADAPTER = creationAdapter_;
        CREATION_POT = creationPot_;
        CREATION_FEE = creationFee_;
    }

    /// @notice Create through the selected existing factory and atomically convert the exact fee.
    /// @param minZapsOut Caller-reviewed minimum 0xZAPS output for the immutable conversion route.
    function createZap(Lineage lineage, Policy calldata p, bytes32 salt, uint256 minZapsOut)
        external
        payable
        nonReentrant
        returns (address zap)
    {
        if (msg.value != CREATION_FEE) revert IncorrectCreationFee(msg.value, CREATION_FEE);
        if (minZapsOut == 0) revert ZeroMinZapsOut();

        address factory = lineageFactory(lineage);
        address predicted = IOpenZapFactoryLike(factory).predict(p, salt);
        zap = IOpenZapFactoryLike(factory).createZap(p, salt);
        if (zap != predicted) revert PredictedZapMismatch(predicted, zap);
        if (zap.code.length == 0) revert CreatedZapHasNoCode(zap);

        uint256 preWeth = IERC20(AEWETH).balanceOf(address(this));
        IAeWETH(AEWETH).deposit{value: msg.value}();
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

        emit CreationFeeConverted(zap, p.owner, lineage, factory, msg.value, zapsOut);
    }

    function predict(Lineage lineage, Policy calldata p, bytes32 salt) external view returns (address) {
        return IOpenZapFactoryLike(lineageFactory(lineage)).predict(p, salt);
    }

    function lineageFactory(Lineage lineage) public view returns (address) {
        if (lineage == Lineage.OneShot) return ONE_SHOT_FACTORY;
        if (lineage == Lineage.Trigger) return TRIGGER_FACTORY;
        return RECURRING_FACTORY;
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert AddressHasNoCode(target);
    }
}
