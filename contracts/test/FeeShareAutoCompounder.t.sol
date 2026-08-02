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

contract MockVault is MockToken {
    MockToken public immutable weth;
    mapping(address => uint256) public pendingClaim;
    bool public reverts;

    constructor(MockToken weth_) MockToken("Mock fee shares") {
        weth = weth_;
    }

    function setClaimable(address account, uint256 amount) external {
        pendingClaim[account] = amount;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function claimable(address account, address) external view returns (uint256) {
        return pendingClaim[account];
    }

    function claimFor(address account) external {
        require(!reverts, "vault paused");
        uint256 amount = pendingClaim[account];
        pendingClaim[account] = 0;
        weth.mint(account, amount);
    }
}

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
        returns (address, uint256 amountOut)
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
    address internal keeper = makeAddr("keeper");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        weth = new MockToken("WETH");
        zaps = new MockToken("0xZAPS");
        vault = new MockVault(weth);
        adapter = new MockAdapter(weth, zaps);
        source = new MockOrientedSource(address(weth), address(zaps));
        source.setPriceZapsPerWeth(1000e18);
        adapter.setRate(1000e18);

        comp = new FeeShareAutoCompounder(
            address(vault),
            address(weth),
            address(zaps),
            adapter,
            source,
            9_900, // 99% floor
            100e18, // max route 100 WETH
            1e15, // min route 0.001 WETH
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
        new FeeShareAutoCompounder(
            address(vault), address(weth), address(zaps), adapter, flipped, 9_900, 100e18, 1e15, ""
        );
    }

    function test_wethAccruesPerShareAndRoutes() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e18);

        assertEq(comp.claimableWeth(alice), 0); // not synced yet
        vm.prank(alice);
        comp.route();

        // Alice's 30/40 of 1 WETH = 0.75 WETH -> 750 ZAPS.
        assertEq(zaps.balanceOf(alice), 750e18);
        // Bob's share is still owed as WETH, unrouted.
        assertEq(comp.claimableWeth(bob), 250e15); // 0.25 WETH
    }

    function test_claimWethEscapeHatch() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e18);
        vm.prank(bob);
        comp.claimWeth();
        assertEq(weth.balanceOf(bob), 250e15); // 0.25 WETH
    }

    // AUDIT REGRESSION: a late depositor must not dilute earlier reward, and a
    // 1-wei latecomer must not capture a prior depositor's yield.
    function test_lateDepositorCannotStealPriorReward() public {
        vm.prank(alice);
        comp.deposit(30e18);
        vault.setClaimable(address(comp), 3e18); // earned entirely by alice

        // Attacker deposits 1 wei then tries to grab the reward.
        vault.mint(attacker, 1);
        vm.prank(attacker);
        vault.approve(address(comp), type(uint256).max);
        vm.prank(attacker);
        comp.deposit(1); // sync folds the 3 WETH to alice BEFORE minting

        // Alice keeps the full 3 WETH; attacker gets essentially nothing.
        assertApproxEqAbs(comp.claimableWeth(alice), 3e18, 1e6);
        assertLt(comp.claimableWeth(attacker), 1e6);
    }

    // AUDIT REGRESSION: withdrawing to an empty pool must not strand WETH or
    // hand it to a latecomer.
    function test_withdrawToEmptyPoolStrandsNothing() public {
        vm.prank(alice);
        comp.deposit(30e18);
        vault.setClaimable(address(comp), 3e18);

        // Alice withdraws everything: sync realizes her 3 WETH first.
        vm.prank(alice);
        comp.withdraw(30e18);
        assertEq(comp.totalDeposits(), 0);
        assertEq(comp.claimableWeth(alice), 3e18);

        // A latecomer into the now-empty pool captures nothing of alice's.
        vault.mint(attacker, 1);
        vm.prank(attacker);
        vault.approve(address(comp), type(uint256).max);
        vm.prank(attacker);
        comp.deposit(1);
        assertEq(comp.claimableWeth(attacker), 0);

        vm.prank(alice);
        comp.claimWeth();
        assertEq(weth.balanceOf(alice), 3e18);
    }

    function test_keeperRoutingRequiresOptIn() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e18);
        // Without opt-in a keeper cannot force-convert alice's WETH.
        vm.prank(keeper);
        vm.expectRevert(FeeShareAutoCompounder.NotAuthorized.selector);
        comp.routeFor(alice);

        // After opt-in the keeper may route, and the ZAPS is alice's.
        vm.prank(alice);
        comp.setAutoRoute(true);
        vm.prank(keeper);
        comp.routeFor(alice);
        assertEq(zaps.balanceOf(alice), 750e18);
        assertEq(zaps.balanceOf(keeper), 0);
    }

    // AUDIT REGRESSION: a vault whose claimable() VIEW reverts must not brick
    // withdraw or the claimWeth escape hatch.
    function test_revertingClaimableViewDoesNotBrick() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e18);
        // Break the vault entirely (claimFor reverts). The guarded probe must
        // degrade to no-new-reward, keeping withdraw and claimWeth alive.
        vault.setReverts(true);
        vm.prank(alice);
        comp.withdraw(30e18); // must not revert
        assertEq(vault.balanceOf(alice), 30e18);
        vm.prank(bob);
        comp.claimWeth(); // must not revert
    }

    function test_floorRevertsOnBadExecution() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e18);
        adapter.setRate(980e18); // 98% < 99% floor
        vm.prank(alice);
        vm.expectRevert(FeeShareAutoCompounder.FloorNotMet.selector);
        comp.route();
    }

    function test_routeCapBoundsPerCall() public {
        vault.mint(alice, 0);
        vm.prank(alice);
        comp.deposit(30e18);
        vault.setClaimable(address(comp), 300e18); // alice owed 300 WETH
        vm.prank(alice);
        comp.route();
        // Capped at 100 WETH -> 100_000 ZAPS; 200 WETH stays owed.
        assertEq(zaps.balanceOf(alice), 100_000e18);
        assertEq(comp.claimableWeth(alice), 200e18);
    }

    function test_belowMinRouteReverts() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e12); // dust
        vm.prank(alice);
        vm.expectRevert(FeeShareAutoCompounder.BelowMinRoute.selector);
        comp.route();
    }

    function test_defensiveVaultDoesNotBrickClaim() public {
        _depositBoth();
        vault.setClaimable(address(comp), 1e18);
        // Realize the reward, then the vault breaks; escape hatch still works
        // on already-accounted WETH.
        vm.prank(alice);
        comp.claimWeth();
        vault.setReverts(true);
        vault.setClaimable(address(comp), 5e18);
        // A reverting vault degrades to no-new-reward, never a revert.
        vm.prank(bob);
        comp.claimWeth();
        assertEq(weth.balanceOf(bob), 250e15);
    }

    function testFuzz_conservation(uint96 a, uint96 b, uint96 wethAmount) public {
        uint256 da = bound(uint256(a), 1, 1e24);
        uint256 db = bound(uint256(b), 1, 1e24);
        uint256 w = bound(uint256(wethAmount), 1, 1e21);

        vault.mint(alice, da);
        vault.mint(bob, db);
        vm.prank(alice);
        comp.deposit(da);
        vm.prank(bob);
        comp.deposit(db);

        vault.setClaimable(address(comp), w);
        // Force a sync without changing shares.
        vm.prank(alice);
        comp.claimWeth();

        uint256 owed = comp.claimableWeth(alice) + weth.balanceOf(alice) + comp.claimableWeth(bob);
        assertLe(owed, w);
        assertGe(owed + (da + db) / 1e18 + 2, w);
    }
}
