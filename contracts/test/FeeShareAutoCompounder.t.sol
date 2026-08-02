// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {FeeShareAutoCompounder} from "../src/feeshare/FeeShareAutoCompounder.sol";
import {IAdapter} from "../src/interfaces/IAdapter.sol";
import {IOrientedPriceSource} from "../src/v3_1/interfaces/IOrientedPriceSource.sol";

contract MockToken {
    string public name;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_) {
        name = name_;
    }

    function mint(address to, uint256 amount) public {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(allowance[from][msg.sender] >= value, "allowance");
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= value;
        }
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/// @dev Fee-share vault mock: ERC-20 shares plus claimFor paying WETH.
contract MockVault is MockToken {
    MockToken public immutable weth;
    mapping(address => uint256) public pendingClaim;

    constructor(MockToken weth_) MockToken("Mock fee shares") {
        weth = weth_;
    }

    function setClaimable(address account, uint256 amount) external {
        pendingClaim[account] = amount;
    }

    function claimable(address account, address) external view returns (uint256) {
        return pendingClaim[account];
    }

    function claimFor(address account) external {
        uint256 amount = pendingClaim[account];
        pendingClaim[account] = 0;
        weth.mint(account, amount);
    }
}

/// @dev Swaps WETH into ZAPS at a settable rate in ZAPS-per-WETH 1e18 scale.
contract MockAdapter is IAdapter {
    MockToken public immutable weth;
    MockToken public immutable zaps;
    uint256 public rate1e18 = 1e18;
    bytes public lastData;

    constructor(MockToken weth_, MockToken zaps_) {
        weth = weth_;
        zaps = zaps_;
    }

    function setRate(uint256 rate) external {
        rate1e18 = rate;
    }

    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        returns (address tokenOut, uint256 amountOut)
    {
        require(tokenIn == address(weth), "tokenIn");
        lastData = data;
        weth.transferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * rate1e18) / 1e18;
        zaps.mint(msg.sender, amountOut);
        return (address(zaps), amountOut);
    }
}

contract MockOrientedSource is IOrientedPriceSource {
    address public currency0;
    address public currency1;
    uint256 private price;

    constructor(address c0, address c1) {
        currency0 = c0;
        currency1 = c1;
    }

    function setPriceZapsPerWeth(uint256 zapsPerWeth1e18) external {
        // priceX96 = currency1 per currency0 in Q96.
        price = (zapsPerWeth1e18 * 2 ** 96) / 1e18;
    }

    function priceX96() external view returns (uint256) {
        return price;
    }
}

contract FeeShareAutoCompounderTest is Test {
    MockToken internal weth;
    MockToken internal zaps;
    MockVault internal vault;
    MockAdapter internal adapter;
    MockOrientedSource internal source;
    FeeShareAutoCompounder internal comp;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        weth = new MockToken("WETH");
        zaps = new MockToken("0xZAPS");
        vault = new MockVault(weth);
        adapter = new MockAdapter(weth, zaps);
        source = new MockOrientedSource(address(weth), address(zaps));
        source.setPriceZapsPerWeth(1000e18); // 1 WETH = 1000 ZAPS spot
        adapter.setRate(1000e18);

        comp = new FeeShareAutoCompounder(
            address(vault),
            address(weth),
            address(zaps),
            adapter,
            source,
            9_900, // 99% floor
            1e15, // 0.001 WETH min harvest
            hex"c0ffee"
        );

        vault.mint(alice, 30e18);
        vault.mint(bob, 10e18);
        vm.prank(alice);
        vault.approve(address(comp), type(uint256).max);
        vm.prank(bob);
        vault.approve(address(comp), type(uint256).max);
    }

    function _depositBoth() internal {
        vm.prank(alice);
        comp.deposit(30e18);
        vm.prank(bob);
        comp.deposit(10e18);
    }

    function test_constructorRejectsWrongOrientation() public {
        MockOrientedSource flipped = new MockOrientedSource(address(zaps), address(weth));
        vm.expectRevert(FeeShareAutoCompounder.WrongOrientation.selector);
        new FeeShareAutoCompounder(address(vault), address(weth), address(zaps), adapter, flipped, 9_900, 1e15, "");
    }

    function test_harvestRoutesAndSplitsProRata() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e18);
        comp.harvestAndRoute();

        // 1 WETH * 1000 = 1000 ZAPS out, split 30/40 and 10/40.
        assertEq(comp.claimableZaps(alice), 750e18);
        assertEq(comp.claimableZaps(bob), 250e18);

        vm.prank(alice);
        comp.claimZaps();
        assertEq(zaps.balanceOf(alice), 750e18);
        assertEq(comp.zapsReserve(), 250e18);
    }

    function test_floorRevertsOnBadExecution() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e18);
        adapter.setRate(980e18); // 98% of spot < 99% floor
        vm.expectRevert(FeeShareAutoCompounder.FloorNotMet.selector);
        comp.harvestAndRoute();
    }

    function test_minHarvestGate() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e14); // below 1e15 min
        vm.expectRevert(FeeShareAutoCompounder.BelowMinHarvest.selector);
        comp.harvestAndRoute();
    }

    function test_harvestRevertsWithNoDeposits() public {
        vault.setClaimable(address(comp), 1e18);
        vm.expectRevert(FeeShareAutoCompounder.NoDeposits.selector);
        comp.harvestAndRoute();
    }

    function test_withdrawAnytimeKeepsAccrued() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e18);
        comp.harvestAndRoute();

        vm.prank(alice);
        comp.withdraw(30e18);
        assertEq(vault.balanceOf(alice), 30e18);
        // Accrual earned while deposited survives withdrawal.
        assertEq(comp.claimableZaps(alice), 750e18);

        // New harvests no longer credit the withdrawn depositor.
        vault.setClaimable(address(comp), 1e18);
        comp.harvestAndRoute();
        assertEq(comp.claimableZaps(alice), 750e18);
        assertEq(comp.claimableZaps(bob), 250e18 + 1000e18);
    }

    function test_adapterReceivesFrozenData() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e18);
        comp.harvestAndRoute();
        assertEq(adapter.lastData(), hex"c0ffee");
    }

    function testFuzz_conservation(uint96 a, uint96 b, uint96 wethAmount) public {
        uint256 da = bound(uint256(a), 1, 1e24);
        uint256 db = bound(uint256(b), 1, 1e24);
        uint256 w = bound(uint256(wethAmount), 1e15, 1e21);

        vault.mint(alice, da);
        vault.mint(bob, db);
        vm.prank(alice);
        comp.deposit(da);
        vm.prank(bob);
        comp.deposit(db);

        vault.setClaimable(address(comp), w);
        comp.harvestAndRoute();

        uint256 out = comp.zapsReserve();
        uint256 owed = comp.claimableZaps(alice) + comp.claimableZaps(bob);
        assertLe(owed, out);
        assertGe(owed + (da + db) / 1e18 + 2, out);
    }
}
