// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    INonfungiblePositionManager,
    ISwapRouter02,
    IUniswapV3Factory,
    IUniswapV3PoolMinimal,
    IWETH9
} from "../../src/interfaces/IUniswapV3.sol";

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ALLOWANCE");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ZERO_TO");
        uint256 balance = balanceOf[from];
        require(balance >= amount, "BALANCE");
        balanceOf[from] = balance - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract MockWETH is MockERC20, IWETH9 {
    constructor() MockERC20("Wrapped Ether", "WETH") { }

    function deposit() external payable {
        totalSupply += msg.value;
        balanceOf[msg.sender] += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }

    receive() external payable {
        totalSupply += msg.value;
        balanceOf[msg.sender] += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }
}

contract MockV3Pool is IUniswapV3PoolMinimal {
    uint160 public sqrtPriceX96;
    int24 public currentTick;

    function initialize(uint160 sqrtPriceX96_) external {
        require(sqrtPriceX96 == 0, "ALREADY_INITIALIZED");
        sqrtPriceX96 = sqrtPriceX96_;
    }

    function setTick(int24 tick_) external {
        currentTick = tick_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, currentTick, 0, 1, 1, 0, true);
    }
}

contract MockV3Factory is IUniswapV3Factory {
    mapping(uint24 fee => int24 spacing) public override feeAmountTickSpacing;
    mapping(bytes32 key => address pool) private _pools;

    constructor() {
        feeAmountTickSpacing[500] = 10;
        feeAmountTickSpacing[3000] = 60;
        feeAmountTickSpacing[10_000] = 200;
    }

    function setFeeSpacing(uint24 fee, int24 spacing) external {
        feeAmountTickSpacing[fee] = spacing;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return _pools[_key(tokenA, tokenB, fee)];
    }

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        bytes32 key = _key(tokenA, tokenB, fee);
        pool = _pools[key];
        if (pool == address(0)) {
            pool = address(new MockV3Pool());
            _pools[key] = pool;
        }
    }

    function createInitializedPool(address tokenA, address tokenB, uint24 fee, uint160 sqrtPriceX96)
        external
        returns (address pool)
    {
        pool = this.createPool(tokenA, tokenB, fee);
        if (MockV3Pool(pool).sqrtPriceX96() == 0) MockV3Pool(pool).initialize(sqrtPriceX96);
    }

    function _key(address tokenA, address tokenB, uint24 fee) private pure returns (bytes32) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(token0, token1, fee));
    }
}

    contract MockPositionManager is INonfungiblePositionManager {
        using SafeERC20 for IERC20;

        struct Position {
            address token0;
            address token1;
            address owner;
            uint256 owed0;
            uint256 owed1;
        }

        address public immutable override factory;
        address public router;
        bool public revertCollect;
        uint256 public nextTokenId = 1;
        mapping(uint256 tokenId => Position position) public positions;

        error NotOwner();
        error NotRouter();
        error InsufficientBacking();

        constructor(address factory_) {
            factory = factory_;
        }

        function setRouter(address router_) external {
            require(router == address(0), "ROUTER_ALREADY_SET");
            router = router_;
        }

        function setRevertCollect(bool shouldRevert) external {
            revertCollect = shouldRevert;
        }

        function ownerOf(uint256 tokenId) external view returns (address) {
            address owner = positions[tokenId].owner;
            require(owner != address(0), "NOT_MINTED");
            return owner;
        }

        function createAndInitializePoolIfNecessary(
            address token0,
            address token1,
            uint24 fee,
            uint160 sqrtPriceX96
        ) external payable returns (address pool) {
            pool = MockV3Factory(factory).getPool(token0, token1, fee);
            if (pool == address(0)) pool = MockV3Factory(factory).createPool(token0, token1, fee);
            if (MockV3Pool(pool).sqrtPriceX96() == 0) MockV3Pool(pool).initialize(sqrtPriceX96);
        }

        function mint(MintParams calldata params)
            external
            payable
            returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
        {
            require(params.token0 < params.token1, "TOKEN_ORDER");
            require(block.timestamp <= params.deadline, "DEADLINE");
            require(params.tickLower < params.tickUpper, "TICK_ORDER");

            amount0 = params.amount0Desired;
            amount1 = params.amount1Desired;
            require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "SLIPPAGE");
            if (amount0 > 0) IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
            if (amount1 > 0) IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);

            tokenId = nextTokenId++;
            positions[tokenId] = Position({
                token0: params.token0, token1: params.token1, owner: params.recipient, owed0: 0, owed1: 0
            });
            liquidity = uint128(amount0 + amount1);
        }

        function accrueFees(uint256 tokenId, uint256 amount0, uint256 amount1) external {
            Position storage position = positions[tokenId];
            require(position.owner != address(0), "NOT_MINTED");
            if (
                IERC20(position.token0).balanceOf(address(this)) < position.owed0 + amount0
                    || IERC20(position.token1).balanceOf(address(this)) < position.owed1 + amount1
            ) revert InsufficientBacking();
            position.owed0 += amount0;
            position.owed1 += amount1;
        }

        function collect(CollectParams calldata params)
            external
            payable
            returns (uint256 amount0, uint256 amount1)
        {
            require(!revertCollect, "COLLECT_DISABLED");
            Position storage position = positions[params.tokenId];
            if (msg.sender != position.owner) revert NotOwner();
            amount0 = position.owed0 < params.amount0Max ? position.owed0 : params.amount0Max;
            amount1 = position.owed1 < params.amount1Max ? position.owed1 : params.amount1Max;
            position.owed0 -= amount0;
            position.owed1 -= amount1;
            if (amount0 > 0) IERC20(position.token0).safeTransfer(params.recipient, amount0);
            if (amount1 > 0) IERC20(position.token1).safeTransfer(params.recipient, amount1);
        }

        function transferFrom(address from, address to, uint256 tokenId) external {
            Position storage position = positions[tokenId];
            if (msg.sender != position.owner || from != position.owner) revert NotOwner();
            require(to != address(0), "ZERO_TO");
            position.owner = to;
        }

        function swapOut(address token, address recipient, uint256 amount) external {
            if (msg.sender != router) revert NotRouter();
            IERC20(token).safeTransfer(recipient, amount);
        }
    }

        contract MockSwapRouter is ISwapRouter02 {
            using SafeERC20 for IERC20;

            MockPositionManager public immutable positionManager;
            address public immutable override factory;
            uint256 public outputMultiplier = 1000;

            constructor(address positionManager_) {
                positionManager = MockPositionManager(positionManager_);
                factory = MockPositionManager(positionManager_).factory();
            }

            function setOutputMultiplier(uint256 multiplier) external {
                outputMultiplier = multiplier;
            }

            function exactInputSingle(ExactInputSingleParams calldata params)
                external
                payable
                returns (uint256 amountOut)
            {
                IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(positionManager), params.amountIn);
                amountOut = params.amountIn * outputMultiplier;
                require(amountOut >= params.amountOutMinimum, "TOO_LITTLE_RECEIVED");
                positionManager.swapOut(params.tokenOut, params.recipient, amountOut);
            }
        }
