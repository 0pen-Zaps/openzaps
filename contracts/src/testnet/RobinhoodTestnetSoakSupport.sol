// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {IERC20} from "../interfaces/IERC20.sol";
import {IAdapter} from "../interfaces/IAdapter.sol";
import {IPriceSource} from "../v3/interfaces/IPriceSource.sol";

/// @notice Shared chain guard for disposable Robinhood testnet soak fixtures.
/// @dev TESTNET ONLY / NON-PRODUCTION. These contracts deliberately refuse every chain except
///      Robinhood testnet (46630). They are not substitutes for reviewed production assets,
///      adapters, or price sources.
abstract contract RobinhoodTestnetOnly {
    uint256 public constant ROBINHOOD_TESTNET_CHAIN_ID = 46630;

    error WrongChain(uint256 actualChainId);

    constructor() {
        if (block.chainid != ROBINHOOD_TESTNET_CHAIN_ID) revert WrongChain(block.chainid);
    }
}

/// @title RobinhoodTestnetSoakToken
/// @notice Fixed-supply ERC-20 used only by the disposable chain-46630 executor soak.
/// @dev TESTNET ONLY / NON-PRODUCTION. The complete supply is minted once in the constructor.
///      There is no mint authority, upgrade path, fee, rebasing, permit, or privileged transfer.
contract RobinhoodTestnetSoakToken is RobinhoodTestnetOnly {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public immutable initialSupply;
    address public immutable initialHolder;
    uint256 public totalSupply;

    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ZeroAddress();
    error ZeroSupply();
    error InsufficientBalance(uint256 available, uint256 required);
    error InsufficientAllowance(uint256 available, uint256 required);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address initialHolder_,
        uint256 initialSupply_
    ) {
        if (initialHolder_ == address(0)) revert ZeroAddress();
        if (initialSupply_ == 0) revert ZeroSupply();

        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        initialHolder = initialHolder_;
        initialSupply = initialSupply_;
        totalSupply = initialSupply_;
        balanceOf[initialHolder_] = initialSupply_;
        emit Transfer(address(0), initialHolder_, initialSupply_);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved < value) revert InsufficientAllowance(approved, value);
        if (approved != type(uint256).max) {
            unchecked {
                allowance[from][msg.sender] = approved - value;
            }
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        uint256 available = balanceOf[from];
        if (available < value) revert InsufficientBalance(available, value);
        unchecked {
            balanceOf[from] = available - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}

/// @title RobinhoodTestnetFixedRateAdapter
/// @notice One-route, fixed-rate adapter for the disposable chain-46630 executor soak.
/// @dev TESTNET ONLY / NON-PRODUCTION. Both assets and the rate are constructor-pinned. Calls must
///      supply empty route data, so an executor cannot select a token, venue, rate, or recipient.
contract RobinhoodTestnetFixedRateAdapter is RobinhoodTestnetOnly, IAdapter {
    address public immutable INPUT_TOKEN;
    address public immutable OUTPUT_TOKEN;
    uint256 public immutable RATE_WAD;

    error ZeroAddress();
    error NoCode(address target);
    error SameToken();
    error ZeroRate();
    error WrongInputToken(address actual);
    error RouteDataNotEmpty();
    error ZeroAmount();
    error TransferFailed(address token);

    constructor(address inputToken_, address outputToken_, uint256 rateWad_) {
        if (inputToken_ == address(0) || outputToken_ == address(0)) revert ZeroAddress();
        if (inputToken_.code.length == 0) revert NoCode(inputToken_);
        if (outputToken_.code.length == 0) revert NoCode(outputToken_);
        if (inputToken_ == outputToken_) revert SameToken();
        if (rateWad_ == 0) revert ZeroRate();

        INPUT_TOKEN = inputToken_;
        OUTPUT_TOKEN = outputToken_;
        RATE_WAD = rateWad_;
    }

    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        returns (address tokenOut, uint256 amountOut)
    {
        if (tokenIn != INPUT_TOKEN) revert WrongInputToken(tokenIn);
        if (data.length != 0) revert RouteDataNotEmpty();
        if (amountIn == 0) revert ZeroAmount();

        if (!IERC20(INPUT_TOKEN).transferFrom(msg.sender, address(this), amountIn)) {
            revert TransferFailed(INPUT_TOKEN);
        }

        tokenOut = OUTPUT_TOKEN;
        amountOut = (amountIn * RATE_WAD) / 1e18;
        if (amountOut == 0) revert ZeroAmount();
        if (!IERC20(OUTPUT_TOKEN).transfer(msg.sender, amountOut)) {
            revert TransferFailed(OUTPUT_TOKEN);
        }
    }
}

/// @title RobinhoodTestnetSoakPriceSource
/// @notice Operator-controlled Q96 price fixture for trigger and outage drills on chain 46630.
/// @dev TESTNET ONLY / NON-PRODUCTION. The owner may change the synthetic price or set it to zero;
///      zero makes reads fail closed and is the explicit price-source outage injection.
contract RobinhoodTestnetSoakPriceSource is RobinhoodTestnetOnly, IPriceSource {
    address public immutable owner;
    uint256 private _priceX96;

    event PriceSet(uint256 previousPriceX96, uint256 newPriceX96);

    error ZeroAddress();
    error ZeroInitialPrice();
    error NotOwner();
    error PriceUnavailable();

    constructor(address owner_, uint256 initialPriceX96_) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (initialPriceX96_ == 0) revert ZeroInitialPrice();
        owner = owner_;
        _priceX96 = initialPriceX96_;
        emit PriceSet(0, initialPriceX96_);
    }

    function setPriceX96(uint256 newPriceX96) external {
        if (msg.sender != owner) revert NotOwner();
        emit PriceSet(_priceX96, newPriceX96);
        _priceX96 = newPriceX96;
    }

    function priceX96() external view returns (uint256) {
        uint256 value = _priceX96;
        if (value == 0) revert PriceUnavailable();
        return value;
    }
}
