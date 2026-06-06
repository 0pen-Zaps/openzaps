// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @notice A fee-on-transfer token — the class the curated allowlist exists to exclude (I-TOK-2).
///         Used to prove a non-allowlisted token is rejected at `initialize`.
contract MockFeeOnTransferERC20 {
    string public constant name = "FeeOnTransfer";
    string public constant symbol = "FOT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public constant FEE_BPS = 100; // 1%

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _xfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        return _xfer(from, to, value);
    }

    function _xfer(address from, address to, uint256 value) internal returns (bool) {
        uint256 fee = (value * FEE_BPS) / 10_000;
        balanceOf[from] -= value;
        balanceOf[to] += value - fee; // recipient receives less than sent
        balanceOf[address(0xdead)] += fee;
        return true;
    }
}
