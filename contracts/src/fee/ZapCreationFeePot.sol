// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {SafeApprove} from "../libraries/SafeApprove.sol";

/// @title ZapCreationFeePot
/// @notice No-drain 0xZAPS prize pot funded exclusively by creation fees that its immutable
///         creation gateway has already converted. Every credited token buys tickets for
///         the capsule owner in the current round.
/// @dev The gateway binding is one-shot. Credits are balance-backed, so neither governance nor the
///      gateway can mint tickets without first transferring the corresponding 0xZAPS. Unsolicited
///      token transfers remain unaccounted and cannot be awarded or swept.
contract ZapCreationFeePot {
    using SafeApprove for address;

    address public owner;
    address public pendingOwner;
    address public immutable ZAPS;
    address public gateway;
    address public gatewayInstaller;

    uint256 public currentRound = 1;
    uint256 public accountedZaps;
    mapping(uint256 => mapping(address => uint256)) public tickets;
    mapping(uint256 => uint256) public totalTickets;
    mapping(uint256 => uint256) public roundPrize;

    uint256 private _entered;

    event GatewaySet(address indexed gateway);
    event CreationRecorded(uint256 indexed round, address indexed player, address indexed zap, uint256 amount);
    event RoundAwarded(uint256 indexed round, address indexed winner, uint256 prize);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error NotGateway();
    error NotGatewayBinder();
    error ZeroAddress();
    error GatewayAlreadySet();
    error ZeroAmount();
    error InsufficientUnaccountedBalance();
    error EmptyPrize();
    error WinnerHasNoTickets(uint256 round, address winner);
    error InexactTransfer();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address owner_, address zaps_) {
        if (owner_ == address(0) || zaps_ == address(0)) revert ZeroAddress();
        owner = owner_;
        ZAPS = zaps_;
        gatewayInstaller = msg.sender;
        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice Bind the only gateway allowed to record already-transferred creation fees.
    /// @dev The constructor caller may complete this one deployment-time action without receiving
    ///      governance. Its authority is erased as soon as the gateway is bound.
    function setGateway(address gateway_) external {
        if (gateway_ == address(0)) revert ZeroAddress();
        if (gateway != address(0)) revert GatewayAlreadySet();
        if (msg.sender != owner && msg.sender != gatewayInstaller) revert NotGatewayBinder();
        gateway = gateway_;
        gatewayInstaller = address(0);
        emit GatewaySet(gateway_);
    }

    /// @notice Credit an already-transferred 0xZAPS creation fee to the capsule owner.
    function recordCreation(address player, address zap, uint256 amount) external nonReentrant {
        if (msg.sender != gateway || gateway == address(0)) revert NotGateway();
        if (player == address(0) || zap == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (IERC20(ZAPS).balanceOf(address(this)) < accountedZaps + amount) {
            revert InsufficientUnaccountedBalance();
        }

        accountedZaps += amount;
        uint256 round = currentRound;
        tickets[round][player] += amount;
        totalTickets[round] += amount;
        roundPrize[round] += amount;
        emit CreationRecorded(round, player, zap, amount);
    }

    /// @notice Award exactly the current round's accounted prize to one ticket holder.
    /// @dev Governance cannot withdraw or choose an address without tickets.
    function awardRound(address winner) external onlyOwner nonReentrant {
        if (winner == address(0)) revert ZeroAddress();
        uint256 round = currentRound;
        uint256 prize = roundPrize[round];
        if (prize == 0) revert EmptyPrize();
        if (tickets[round][winner] == 0) revert WinnerHasNoTickets(round, winner);
        if (accountedZaps < prize) revert InexactTransfer();

        roundPrize[round] = 0;
        currentRound = round + 1;
        accountedZaps -= prize;

        uint256 prePot = IERC20(ZAPS).balanceOf(address(this));
        uint256 preWinner = IERC20(ZAPS).balanceOf(winner);
        ZAPS.safeTransfer(winner, prize);
        if (
            prePot - IERC20(ZAPS).balanceOf(address(this)) != prize
                || IERC20(ZAPS).balanceOf(winner) - preWinner != prize
        ) revert InexactTransfer();
        emit RoundAwarded(round, winner, prize);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
