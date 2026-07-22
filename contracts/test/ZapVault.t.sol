// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {ZapVault} from "../src/primitives/ZapVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockFeeOnTransferERC20} from "./mocks/MockFeeOnTransferERC20.sol";

/// @notice An asset that calls back into the vault on every transfer, i.e. the hostile-underlying
///         case. Used to prove the reentrancy guard, not to suggest such an asset is supported.
contract ReenteringERC20 {
    string public constant name = "Reenter";
    string public constant symbol = "RE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public target;
    bytes public payload;
    bool public armed;
    bool public lastCallSucceeded;
    bytes public lastReturnData;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _xfer(msg.sender, to, value);
        _callback();
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _xfer(from, to, value);
        _callback();
        return true;
    }

    function _xfer(address from, address to, uint256 value) private {
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function _callback() private {
        if (!armed) return;
        armed = false; // one shot
        (bool ok, bytes memory ret) = target.call(payload);
        lastCallSucceeded = ok;
        lastReturnData = ret;
    }
}

contract NoDecimalsERC20 {
    mapping(address => uint256) public balanceOf;
}

contract HugeDecimalsERC20 {
    function decimals() external pure returns (uint8) {
        return 255;
    }
}

contract ZapVaultTest is Test {
    MockERC20 internal token;
    ZapVault internal vault;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal attacker = address(0xBAD);

    uint256 internal constant VIRTUAL_SHARES = 1_000;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    function setUp() public {
        token = new MockERC20("Mock USD", "mUSD", 18);
        vault = new ZapVault(address(token), "ZapVault mUSD", "zvUSD");

        token.mint(alice, 1_000_000 ether);
        token.mint(bob, 1_000_000 ether);
        token.mint(attacker, 1_000_000 ether);

        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
        vm.prank(attacker);
        token.approve(address(vault), type(uint256).max);
    }

    // ------------------------------------------------------------------ //
    // Metadata & construction                                            //
    // ------------------------------------------------------------------ //

    function test_metadata() public view {
        assertEq(vault.asset(), address(token));
        assertEq(vault.decimals(), 21); // 18 + DECIMALS_OFFSET(3)
        assertEq(vault.name(), "ZapVault mUSD");
        assertEq(vault.symbol(), "zvUSD");
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.totalSupply(), 0);
    }

    function test_constructorRejectsZeroAsset() public {
        vm.expectRevert(ZapVault.ZeroAddress.selector);
        new ZapVault(address(0), "x", "x");
    }

    function test_constructorRejectsEOA() public {
        vm.expectRevert(abi.encodeWithSelector(ZapVault.NoCode.selector, alice));
        new ZapVault(alice, "x", "x");
    }

    function test_constructorRejectsAssetWithoutDecimals() public {
        NoDecimalsERC20 weird = new NoDecimalsERC20();
        vm.expectRevert(ZapVault.AssetDecimalsUnavailable.selector);
        new ZapVault(address(weird), "x", "x");
    }

    function test_constructorRejectsAbsurdDecimals() public {
        HugeDecimalsERC20 weird = new HugeDecimalsERC20();
        vm.expectRevert(abi.encodeWithSelector(ZapVault.AssetDecimalsTooLarge.selector, uint256(255)));
        new ZapVault(address(weird), "x", "x");
    }

    function test_sixDecimalAssetKeepsOffset() public {
        MockERC20 usdc = new MockERC20("USDC", "USDC", 6);
        ZapVault v = new ZapVault(address(usdc), "ZapVault USDC", "zvUSDC");
        assertEq(v.decimals(), 9);
    }

    /// @notice There is no admin surface at all: the contract exposes no owner/pause/upgrade/fee
    ///         entry point. Any call to one of those selectors hits the fallback and reverts.
    function test_noAdminSurface() public {
        string[8] memory sigs = [
            "owner()",
            "pause()",
            "unpause()",
            "upgradeTo(address)",
            "setFee(uint256)",
            "sweep(address)",
            "transferOwnership(address)",
            "initialize(address)"
        ];
        for (uint256 i; i < sigs.length; ++i) {
            (bool ok,) = address(vault).call(abi.encodeWithSignature(sigs[i]));
            assertFalse(ok, sigs[i]);
        }
    }

    /// @notice No `receive()`/`payable` anywhere: native ETH cannot enter the vault.
    function test_rejectsNativeEth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(vault).balance, 0);
    }

    // ------------------------------------------------------------------ //
    // The first-depositor / donation inflation attack                    //
    // ------------------------------------------------------------------ //

    /// @notice The classic ERC-4626 front-run: attacker deposits 1 wei, donates a large amount to
    ///         inflate the share price, and hopes the victim's deposit rounds to zero shares so the
    ///         attacker's single share owns everything. The virtual offset must make this both
    ///         ineffective (victim keeps essentially all principal) and unprofitable (attacker's
    ///         exit is worth less than they put in).
    function test_firstDepositorInflationAttackFails() public {
        uint256 donation = 10_000 ether;
        uint256 victimDeposit = 10_000 ether;

        vm.prank(attacker);
        uint256 attackerShares = vault.deposit(1, attacker);
        assertGt(attackerShares, 0);

        // Donate directly to the vault — no shares minted, share price jumps.
        vm.prank(attacker);
        token.transfer(address(vault), donation);

        vm.prank(alice);
        uint256 victimShares = vault.deposit(victimDeposit, alice);
        assertGt(victimShares, 0, "victim shares must not round to zero");

        // Both exit.
        vm.prank(alice);
        uint256 victimOut = vault.redeem(victimShares, alice, alice);
        vm.prank(attacker);
        uint256 attackerOut = vault.redeem(attackerShares, attacker, attacker);

        uint256 attackerIn = donation + 1;
        uint256 victimLoss = victimDeposit - victimOut;

        assertLe(victimOut, victimDeposit, "victim cannot profit either");
        // The attacker had to burn more than VIRTUAL_SHARES times what the victim lost.
        assertLe(victimLoss, donation / VIRTUAL_SHARES, "victim loss not bounded by attacker cost / 1000");

        // The attack costs the attacker money; it does not pay for itself. Most of the donation is
        // simply handed to the victim.
        assertLt(attackerOut, attackerIn, "attack must be unprofitable");
        emit log_named_uint("attacker spent", attackerIn);
        emit log_named_uint("attacker recovered", attackerOut);
        emit log_named_uint("victim principal", victimDeposit);
        emit log_named_uint("victim recovered", victimOut);
    }

    /// @notice The same attack across a wide range of donation and victim sizes. Two properties are
    ///         asserted, and they are the honest ones: the attacker never profits, and the victim's
    ///         rounding loss is bounded by the attacker's cost divided by VIRTUAL_SHARES. Where the
    ///         donation is so large that the victim's deposit would round to nothing, the deposit
    ///         reverts instead — a griefed transaction, never a confiscated one.
    function testFuzz_inflationAttackNeverPays(uint128 donation, uint128 victimDeposit) public {
        donation = uint128(bound(donation, 0, 500_000 ether));
        victimDeposit = uint128(bound(victimDeposit, 1, 500_000 ether));

        vm.prank(attacker);
        uint256 attackerShares = vault.deposit(1, attacker);
        if (donation != 0) {
            vm.prank(attacker);
            token.transfer(address(vault), donation);
        }

        if (vault.previewDeposit(victimDeposit) == 0) {
            vm.expectRevert(abi.encodeWithSelector(ZapVault.ZeroShares.selector, uint256(victimDeposit)));
            vm.prank(alice);
            vault.deposit(victimDeposit, alice);
            return; // victim keeps 100% of principal
        }

        vm.prank(alice);
        uint256 victimShares = vault.deposit(victimDeposit, alice);
        assertGt(victimShares, 0);

        // A position worth strictly less than 1 wei cannot be redeemed (ZeroAssets); treat it as a
        // zero recovery, which is the worst case for the victim and the best case for the attacker.
        uint256 victimOut;
        if (vault.previewRedeem(victimShares) != 0) {
            vm.prank(alice);
            victimOut = vault.redeem(victimShares, alice, alice);
        }
        uint256 attackerOut;
        if (vault.previewRedeem(attackerShares) != 0) {
            vm.prank(attacker);
            attackerOut = vault.redeem(attackerShares, attacker, attacker);
        }

        // Attacker never ends up ahead of what they committed (1 wei deposit + the donation).
        assertLe(attackerOut, uint256(donation) + 1, "attacker profited");
        // Victim's loss is bounded by attackerCost / VIRTUAL_SHARES (+1 wei of absolute rounding).
        uint256 victimLoss = victimOut >= victimDeposit ? 0 : victimDeposit - victimOut;
        assertLe(victimLoss, uint256(donation) / VIRTUAL_SHARES + 1, "loss not bounded by attacker cost");
    }

    /// @notice A deposit that would round to zero shares is refused outright.
    function test_depositRoundingToZeroSharesReverts() public {
        vm.prank(attacker);
        vault.deposit(1, attacker);
        vm.prank(attacker);
        token.transfer(address(vault), 100_000 ether);

        vm.expectRevert(abi.encodeWithSelector(ZapVault.ZeroShares.selector, uint256(1)));
        vm.prank(alice);
        vault.deposit(1, alice);
    }

    /// @notice A redeem that would pay zero assets is refused rather than burning shares for free.
    function test_redeemRoundingToZeroAssetsReverts() public {
        vm.prank(alice);
        vault.deposit(1_000, alice); // 1e6 shares backing 1000 wei

        vm.expectRevert(abi.encodeWithSelector(ZapVault.ZeroAssets.selector, uint256(1)));
        vm.prank(alice);
        vault.redeem(1, alice, alice);
    }

    /// @notice A pure donation into an empty vault is not free money for the next depositor: they
    ///         absorb it, but never mint something from nothing.
    function test_donationIntoEmptyVaultIsNotFreeMoney() public {
        vm.prank(attacker);
        token.transfer(address(vault), 1_000 ether);

        vm.prank(alice);
        uint256 shares = vault.deposit(10 ether, alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);

        // Alice can never withdraw more than she deposited plus the donation that was already there.
        assertLe(out, 1_010 ether);
        // And the vault is never left insolvent.
        assertGe(vault.totalAssets(), vault.convertToAssets(vault.totalSupply()));
    }

    /// @notice HONEST LIMITATION, asserted rather than hidden: donating X into an empty vault sets
    ///         the price floor at X / VIRTUAL_SHARES per share, so deposits below that threshold
    ///         revert with `ZeroShares`. Nothing is stolen — the deposit simply does not happen —
    ///         but it is a griefing vector on a freshly deployed, unseeded vault, and the griefer
    ///         must burn 1000x the deposit size they want to block. Seed the vault at deployment.
    function test_emptyVaultDonationGriefsSmallDepositsAtOneThousandXCost() public {
        uint256 donation = 1_000 ether;
        vm.prank(attacker);
        token.transfer(address(vault), donation);

        uint256 threshold = donation / VIRTUAL_SHARES; // 1 ether

        vm.expectRevert(abi.encodeWithSelector(ZapVault.ZeroShares.selector, threshold - 1));
        vm.prank(alice);
        vault.deposit(threshold - 1, alice);

        // At and above the threshold the deposit works normally.
        vm.prank(alice);
        assertGt(vault.deposit(threshold + 1, alice), 0);
    }

    // ------------------------------------------------------------------ //
    // Rounding: every path must round against the caller                 //
    // ------------------------------------------------------------------ //

    function testFuzz_roundingNeverFavoursTheCaller(uint128 seedAssets, uint128 donation, uint128 amount) public {
        seedAssets = uint128(bound(seedAssets, 1, 100_000 ether));
        donation = uint128(bound(donation, 0, 100_000 ether));
        amount = uint128(bound(amount, 0, 100_000 ether));

        vm.prank(bob);
        vault.deposit(seedAssets, bob);
        if (donation != 0) {
            vm.prank(attacker);
            token.transfer(address(vault), donation);
        }

        // deposit rounds shares DOWN, mint rounds assets UP  =>  previewMint(previewDeposit(a)) <= a
        uint256 sharesForA = vault.previewDeposit(amount);
        assertLe(vault.previewMint(sharesForA), amount, "deposit/mint round trip minted value from air");

        // redeem rounds assets DOWN, withdraw rounds shares UP => previewWithdraw(previewRedeem(s)) <= s
        uint256 assetsForS = vault.previewRedeem(amount);
        assertLe(vault.previewWithdraw(assetsForS), amount, "redeem/withdraw round trip created shares");

        // Rounding-up previews are never below their rounding-down counterparts.
        assertGe(vault.previewMint(amount), vault.previewRedeem(amount));
        assertGe(vault.previewWithdraw(amount), vault.previewDeposit(amount));
    }

    /// @notice Deposit-then-immediately-withdraw must never return more than was put in, at any
    ///         share price, for any caller. This is the "no free money" invariant.
    function testFuzz_depositRedeemRoundTripNeverProfits(uint128 seedAssets, uint128 donation, uint128 amount) public {
        seedAssets = uint128(bound(seedAssets, 1, 100_000 ether));
        donation = uint128(bound(donation, 0, 100_000 ether));
        amount = uint128(bound(amount, 0, 100_000 ether));

        vm.prank(bob);
        vault.deposit(seedAssets, bob);
        if (donation != 0) {
            vm.prank(attacker);
            token.transfer(address(vault), donation);
        }
        if (amount != 0 && vault.previewDeposit(amount) == 0) return; // refused by ZeroShares

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        uint256 shares = vault.deposit(amount, alice);
        if (shares != 0 && vault.previewRedeem(shares) == 0) return; // refused by ZeroAssets
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        assertLe(token.balanceOf(alice), before, "round trip produced free assets");
    }

    /// @notice And the mirror: mint-then-withdraw-everything must not profit either.
    function testFuzz_mintWithdrawRoundTripNeverProfits(uint128 seedAssets, uint128 donation, uint128 shares) public {
        seedAssets = uint128(bound(seedAssets, 1, 100_000 ether));
        donation = uint128(bound(donation, 0, 100_000 ether));
        shares = uint128(bound(shares, 0, 100_000 ether));

        vm.prank(bob);
        vault.deposit(seedAssets, bob);
        if (donation != 0) {
            vm.prank(attacker);
            token.transfer(address(vault), donation);
        }

        uint256 before = token.balanceOf(alice);
        if (vault.previewMint(shares) > before) return; // alice cannot afford it; not the property under test

        vm.prank(alice);
        vault.mint(shares, alice);
        uint256 withdrawable = vault.maxWithdraw(alice);
        uint256 sharesBefore = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 burned = vault.withdraw(withdrawable, alice, alice);

        // maxWithdraw must be honestly withdrawable: it never burns more shares than the owner has.
        assertLe(burned, sharesBefore, "maxWithdraw over-promised");
        assertLe(token.balanceOf(alice), before, "round trip produced free assets");
    }

    /// @notice The vault must always hold at least what all outstanding shares can claim.
    function testFuzz_solvency(uint128 a, uint128 b, uint128 donation) public {
        a = uint128(bound(a, 1, 100_000 ether));
        b = uint128(bound(b, 1, 100_000 ether));
        donation = uint128(bound(donation, 0, 100_000 ether));

        vm.prank(alice);
        vault.deposit(a, alice);
        vm.prank(bob);
        vault.deposit(b, bob);
        if (donation != 0) {
            vm.prank(attacker);
            token.transfer(address(vault), donation);
        }

        uint256 claimable = vault.convertToAssets(vault.balanceOf(alice)) + vault.convertToAssets(vault.balanceOf(bob));
        assertLe(claimable, vault.totalAssets(), "vault is insolvent");

        // Both can actually exit, in either order. Balances are hoisted out of the argument
        // position: an arg-position call would consume the vm.prank.
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);
        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        assertEq(vault.totalSupply(), 0);
    }

    // ------------------------------------------------------------------ //
    // Core deposit / withdraw behaviour                                  //
    // ------------------------------------------------------------------ //

    function test_depositMintWithdrawRedeemHappyPath() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(100 ether, alice);
        assertEq(shares, 100 ether * VIRTUAL_SHARES);
        assertEq(vault.balanceOf(alice), shares);
        assertEq(vault.totalAssets(), 100 ether);

        vm.prank(bob);
        uint256 paid = vault.mint(50 ether * VIRTUAL_SHARES, bob);
        assertApproxEqAbs(paid, 50 ether, 1);
        assertEq(vault.balanceOf(bob), 50 ether * VIRTUAL_SHARES);

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        uint256 burned = vault.withdraw(40 ether, alice, alice);
        assertEq(token.balanceOf(alice), aliceBefore + 40 ether);
        assertEq(vault.balanceOf(alice), shares - burned);

        uint256 bobShares = vault.balanceOf(bob); // hoisted: an arg-position call eats vm.prank
        vm.prank(bob);
        uint256 got = vault.redeem(bobShares, bob, bob);
        assertApproxEqAbs(got, 50 ether, 2);
        assertEq(vault.balanceOf(bob), 0);
    }

    function test_emitsCanonicalErc4626Events() public {
        uint256 expectedShares = 100 ether * VIRTUAL_SHARES;

        vm.expectEmit(true, true, false, true, address(vault));
        emit ZapVault.Transfer(address(0), alice, expectedShares);
        vm.expectEmit(true, true, false, true, address(vault));
        emit ZapVault.Deposit(alice, alice, 100 ether, expectedShares);
        vm.prank(alice);
        vault.deposit(100 ether, alice);

        uint256 burnShares = vault.previewWithdraw(40 ether);
        vm.expectEmit(true, true, false, true, address(vault));
        emit ZapVault.Transfer(alice, address(0), burnShares);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ZapVault.Withdraw(alice, bob, alice, 40 ether, burnShares);
        vm.prank(alice);
        vault.withdraw(40 ether, bob, alice);
    }

    /// @notice The shape the OpenZap settlement model needs: exactly one ERC-20 in, exactly one
    ///         ERC-20 out, credited to a caller-chosen receiver, with the return value equal to the
    ///         measured receipt delta. (OpenZap settles on a measured balance delta, so an adapter
    ///         wrapping this vault must be able to rely on that equality.)
    function test_oneTokenInOneReceiptOutForAnArbitraryReceiver() public {
        address adapterLike = address(0xADA9);
        token.mint(adapterLike, 10 ether);
        vm.prank(adapterLike);
        token.approve(address(vault), 10 ether);

        uint256 receiptBefore = vault.balanceOf(bob);
        uint256 assetBefore = token.balanceOf(adapterLike);

        vm.prank(adapterLike);
        uint256 shares = vault.deposit(10 ether, bob);

        assertEq(assetBefore - token.balanceOf(adapterLike), 10 ether, "asset debited inexactly");
        assertEq(vault.balanceOf(bob) - receiptBefore, shares, "receipt delta != return value");
        assertEq(vault.balanceOf(adapterLike), 0, "vault must not strand a receipt on the caller");
        assertEq(token.balanceOf(address(vault)), 10 ether);
    }

    function test_donationAccruesProRata() public {
        vm.prank(alice);
        vault.deposit(100 ether, alice);
        vm.prank(bob);
        vault.deposit(100 ether, bob);

        vm.prank(attacker);
        token.transfer(address(vault), 100 ether); // "yield"

        // Both holders share it evenly.
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(alice)), 150 ether, 1e12);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(bob)), 150 ether, 1e12);
    }

    function test_withdrawToDifferentReceiver() public {
        vm.prank(alice);
        vault.deposit(100 ether, alice);
        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(alice);
        vault.withdraw(10 ether, bob, alice);
        assertEq(token.balanceOf(bob), bobBefore + 10 ether);
    }

    function test_thirdPartyWithdrawSpendsShareAllowance() public {
        vm.prank(alice);
        vault.deposit(100 ether, alice);
        uint256 shares = vault.previewWithdraw(10 ether);

        vm.expectRevert(abi.encodeWithSelector(ZapVault.InsufficientAllowance.selector, alice, bob, uint256(0), shares));
        vm.prank(bob);
        vault.withdraw(10 ether, bob, alice);

        vm.prank(alice);
        vault.approve(bob, shares);
        vm.prank(bob);
        vault.withdraw(10 ether, bob, alice);
        assertEq(vault.allowance(alice, bob), 0);
    }

    function test_infiniteShareAllowanceIsNotDecremented() public {
        vm.prank(alice);
        vault.deposit(100 ether, alice);
        vm.prank(alice);
        vault.approve(bob, type(uint256).max);
        vm.prank(bob);
        vault.redeem(1 ether * VIRTUAL_SHARES, bob, alice);
        assertEq(vault.allowance(alice, bob), type(uint256).max);
    }

    function test_cannotRedeemMoreThanOwned() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(100 ether, alice);
        vm.expectRevert(abi.encodeWithSelector(ZapVault.InsufficientBalance.selector, alice, shares, shares + 1));
        vm.prank(alice);
        vault.redeem(shares + 1, alice, alice);
    }

    function test_rejectsZeroAndSelfReceiver() public {
        vm.expectRevert(abi.encodeWithSelector(ZapVault.InvalidReceiver.selector, address(0)));
        vm.prank(alice);
        vault.deposit(1 ether, address(0));

        vm.expectRevert(abi.encodeWithSelector(ZapVault.InvalidReceiver.selector, address(vault)));
        vm.prank(alice);
        vault.deposit(1 ether, address(vault));

        vm.prank(alice);
        vault.deposit(1 ether, alice);

        vm.expectRevert(abi.encodeWithSelector(ZapVault.InvalidReceiver.selector, address(vault)));
        vm.prank(alice);
        vault.withdraw(1, address(vault), alice);
    }

    // ------------------------------------------------------------------ //
    // Zero-value calls                                                   //
    // ------------------------------------------------------------------ //

    function test_zeroValueCallsAreHarmlessNoOps() public {
        vm.prank(alice);
        vault.deposit(100 ether, alice);

        uint256 supply = vault.totalSupply();
        uint256 assets = vault.totalAssets();
        uint256 aliceShares = vault.balanceOf(alice);
        uint256 aliceTokens = token.balanceOf(alice);

        vm.startPrank(alice);
        assertEq(vault.deposit(0, alice), 0);
        assertEq(vault.mint(0, alice), 0);
        assertEq(vault.withdraw(0, alice, alice), 0);
        assertEq(vault.redeem(0, alice, alice), 0);
        vm.stopPrank();

        assertEq(vault.totalSupply(), supply);
        assertEq(vault.totalAssets(), assets);
        assertEq(vault.balanceOf(alice), aliceShares);
        assertEq(token.balanceOf(alice), aliceTokens);
    }

    function test_zeroValueCallsOnEmptyVault() public {
        vm.startPrank(alice);
        assertEq(vault.deposit(0, alice), 0);
        assertEq(vault.mint(0, alice), 0);
        assertEq(vault.redeem(0, alice, alice), 0);
        assertEq(vault.withdraw(0, alice, alice), 0);
        vm.stopPrank();
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.totalAssets(), 0);
    }

    function test_previewsOnEmptyVault() public view {
        assertEq(vault.convertToShares(0), 0);
        assertEq(vault.convertToAssets(0), 0);
        assertEq(vault.previewDeposit(1 ether), 1 ether * VIRTUAL_SHARES);
        assertEq(vault.previewMint(1 ether * VIRTUAL_SHARES), 1 ether);
        assertEq(vault.maxRedeem(alice), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxDeposit(alice), type(uint256).max);
        assertEq(vault.maxMint(alice), type(uint256).max);
    }

    // ------------------------------------------------------------------ //
    // Fee-on-transfer: explicit refusal                                  //
    // ------------------------------------------------------------------ //

    function test_feeOnTransferAssetCannotDeposit() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20();
        ZapVault v = new ZapVault(address(fot), "fot", "fot");
        fot.mint(alice, 1_000 ether);
        vm.prank(alice);
        fot.approve(address(v), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(ZapVault.InexactAssetTransfer.selector, uint256(100 ether), uint256(99 ether))
        );
        vm.prank(alice);
        v.deposit(100 ether, alice);

        assertEq(v.totalSupply(), 0);
        assertEq(v.totalAssets(), 0);
    }

    function test_feeOnTransferAssetCannotMintEither() public {
        MockFeeOnTransferERC20 fot = new MockFeeOnTransferERC20();
        ZapVault v = new ZapVault(address(fot), "fot", "fot");
        fot.mint(alice, 1_000 ether);
        vm.prank(alice);
        fot.approve(address(v), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert();
        v.mint(100 ether * VIRTUAL_SHARES, alice);
    }

    // ------------------------------------------------------------------ //
    // Reentrancy                                                         //
    // ------------------------------------------------------------------ //

    function test_reentrantDepositDuringDepositReverts() public {
        ReenteringERC20 evil = new ReenteringERC20();
        ZapVault v = new ZapVault(address(evil), "evil", "evil");
        evil.mint(alice, 1_000 ether);
        vm.prank(alice);
        evil.approve(address(v), type(uint256).max);

        evil.arm(address(v), abi.encodeCall(ZapVault.deposit, (1 ether, alice)));
        vm.prank(alice);
        v.deposit(100 ether, alice);

        assertFalse(evil.lastCallSucceeded(), "reentrant deposit was not blocked");
        assertEq(bytes4(evil.lastReturnData()), ZapVault.Reentrancy.selector);
        // The outer deposit still settled exactly once.
        assertEq(v.totalAssets(), 100 ether);
        assertEq(v.balanceOf(alice), 100 ether * VIRTUAL_SHARES);
    }

    function test_reentrantRedeemDuringWithdrawReverts() public {
        ReenteringERC20 evil = new ReenteringERC20();
        ZapVault v = new ZapVault(address(evil), "evil", "evil");
        evil.mint(alice, 1_000 ether);
        vm.prank(alice);
        evil.approve(address(v), type(uint256).max);
        vm.prank(alice);
        uint256 shares = v.deposit(100 ether, alice);

        evil.arm(address(v), abi.encodeCall(ZapVault.redeem, (shares, alice, alice)));
        vm.prank(alice);
        v.withdraw(10 ether, alice, alice);

        assertFalse(evil.lastCallSucceeded(), "reentrant redeem was not blocked");
        assertEq(bytes4(evil.lastReturnData()), ZapVault.Reentrancy.selector);
        assertEq(v.totalAssets(), 90 ether);
    }

    /// @notice Even without the guard the accounting is burn-before-transfer; this proves the guard
    ///         is what stops it, and that a blocked reentrancy leaves no partial state behind.
    function test_reentrancyGuardResetsAfterCall() public {
        ReenteringERC20 evil = new ReenteringERC20();
        ZapVault v = new ZapVault(address(evil), "evil", "evil");
        evil.mint(alice, 1_000 ether);
        vm.prank(alice);
        evil.approve(address(v), type(uint256).max);

        evil.arm(address(v), abi.encodeCall(ZapVault.deposit, (1 ether, alice)));
        vm.prank(alice);
        v.deposit(10 ether, alice);

        // A subsequent, non-reentrant deposit still works.
        vm.prank(alice);
        v.deposit(10 ether, alice);
        assertEq(v.totalAssets(), 20 ether);
    }

    // ------------------------------------------------------------------ //
    // Share token (ERC-20) behaviour                                     //
    // ------------------------------------------------------------------ //

    function test_shareTransfersMoveTheClaim() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(100 ether, alice);

        vm.prank(alice);
        vault.transfer(bob, shares);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.balanceOf(bob), shares);

        vm.prank(bob);
        uint256 out = vault.redeem(shares, bob, bob);
        assertEq(out, 100 ether);
    }

    function test_shareTransferFromRespectsAllowance() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(100 ether, alice);

        vm.expectRevert(abi.encodeWithSelector(ZapVault.InsufficientAllowance.selector, alice, bob, uint256(0), shares));
        vm.prank(bob);
        vault.transferFrom(alice, bob, shares);

        vm.prank(alice);
        vault.approve(bob, shares);
        vm.prank(bob);
        vault.transferFrom(alice, bob, shares);
        assertEq(vault.balanceOf(bob), shares);
        assertEq(vault.allowance(alice, bob), 0);
    }

    function test_shareTransferToZeroReverts() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1 ether, alice);
        vm.expectRevert(abi.encodeWithSelector(ZapVault.InvalidReceiver.selector, address(0)));
        vm.prank(alice);
        vault.transfer(address(0), shares);
    }

    function test_shareTransferBeyondBalanceReverts() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1 ether, alice);
        vm.expectRevert(abi.encodeWithSelector(ZapVault.InsufficientBalance.selector, alice, shares, shares + 1));
        vm.prank(alice);
        vault.transfer(bob, shares + 1);
    }

    // ------------------------------------------------------------------ //
    // Multi-user sequencing                                              //
    // ------------------------------------------------------------------ //

    function testFuzz_sequenceKeepsVaultSolvent(uint128[8] calldata amounts, bool[8] calldata isWithdraw) public {
        address[2] memory users = [alice, bob];
        for (uint256 i; i < 8; ++i) {
            address user = users[i % 2];
            uint256 amount = bound(uint256(amounts[i]), 0, 10_000 ether);
            vm.startPrank(user);
            if (isWithdraw[i]) {
                uint256 shares = vault.balanceOf(user);
                uint256 toBurn = shares == 0 ? 0 : bound(amount, 0, shares);
                if (toBurn != 0 && vault.previewRedeem(toBurn) != 0) vault.redeem(toBurn, user, user);
            } else if (amount == 0 || vault.previewDeposit(amount) != 0) {
                vault.deposit(amount, user);
            }
            vm.stopPrank();

            uint256 claimable =
                vault.convertToAssets(vault.balanceOf(alice)) + vault.convertToAssets(vault.balanceOf(bob));
            assertLe(claimable, vault.totalAssets(), "insolvent mid-sequence");
        }

        // Everyone can still get out. Two passes, because one holder's exit can lift the other's
        // sub-wei dust back above the ZeroAssets floor. The invariant that must hold at the end:
        // nobody is left holding a claim worth something they cannot redeem.
        for (uint256 round; round < 2; ++round) {
            _exitAll(alice);
            _exitAll(bob);
        }
        assertEq(vault.convertToAssets(vault.balanceOf(alice)), 0, "alice left redeemable value behind");
        assertEq(vault.convertToAssets(vault.balanceOf(bob)), 0, "bob left redeemable value behind");
    }

    function _exitAll(address user) private {
        uint256 shares = vault.balanceOf(user);
        if (shares == 0 || vault.previewRedeem(shares) == 0) return;
        vm.prank(user);
        vault.redeem(shares, user, user);
    }
}
