// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {IAdapter} from "../src/interfaces/IAdapter.sol";
import {ZapVault} from "../src/primitives/ZapVault.sol";
import {ZapVaultDepositAdapter} from "../src/adapters/ZapVaultDepositAdapter.sol";
import {ZapVaultRedeemAdapter} from "../src/adapters/ZapVaultRedeemAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice An asset that calls back into an arbitrary target on every transfer — the hostile
///         underlying. Used only to prove the adapters' reentrancy guards. It swallows the inner
///         revert and records it so a test can read which guard tripped.
contract CallbackERC20 {
    string public constant name = "Callback";
    string public constant symbol = "CB";
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

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
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
        armed = false; // one shot, so the guard is what stops it and not the mock
        (bool ok, bytes memory ret) = target.call(payload);
        lastCallSucceeded = ok;
        lastReturnData = ret;
    }
}

/// @title ZapVaultAdapters
/// @notice Unit suite for `ZapVaultDepositAdapter` / `ZapVaultRedeemAdapter` — the two adapters that
///         make `src/primitives/ZapVault.sol` reachable from a frozen OpenZap policy at all.
/// @dev No fork: a mock ERC-20, the REAL `ZapVault`, and real `OpenZap` clones from the real factory.
///      The end-to-end tests are the load-bearing ones; the rest pin the refusals.
contract ZapVaultAdaptersTest is Test {
    // Independent copies of the contract's typehashes (a divergence would break signature tests).
    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "OpenZapIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address recipient,address relayer,uint256 maxRelayerFee,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 internal constant OWNER_PK = 0xA11CE;

    /// @dev The round-trip size and the share count it must mint. `ZapVault` prices the first deposit
    ///      into an empty vault at `assets * (0 + VIRTUAL_SHARES) / (0 + VIRTUAL_ASSETS)` =
    ///      `assets * 1000`, exactly. `test_roundTripThroughRealOpenZapClones` asserts that against
    ///      `previewDeposit` before relying on it, so the constant is proved rather than assumed —
    ///      it has to be a constant, because `Step.amountIn` is frozen into the policy at creation.
    uint256 internal constant DEPOSIT_ASSETS = 100 ether;
    uint256 internal constant EXPECTED_SHARES = DEPOSIT_ASSETS * 1_000;

    address internal owner;
    address internal user = address(0x5E7);
    address internal griefer = address(0xBAD);
    address internal finalRecipient = address(0xBEEF);

    MockERC20 internal asset;
    ZapVault internal vault;
    ZapVaultDepositAdapter internal depositAdapter;
    ZapVaultRedeemAdapter internal redeemAdapter;

    AdapterRegistry internal registry;
    TokenAllowlist internal allowlist;
    OpenZapFactory internal factory;

    function setUp() public {
        vm.chainId(ROBINHOOD_CHAIN_ID);
        owner = vm.addr(OWNER_PK);

        asset = new MockERC20("Mock USD", "mUSD", 18);
        vault = new ZapVault(address(asset), "ZapVault mUSD", "zvUSD");
        depositAdapter = new ZapVaultDepositAdapter(address(vault));
        redeemAdapter = new ZapVaultRedeemAdapter(address(vault));

        registry = new AdapterRegistry(address(this));
        allowlist = new TokenAllowlist(address(this));
        factory = new OpenZapFactory(registry, allowlist);

        registry.setAdapter(address(depositAdapter), true);
        registry.setAdapter(address(redeemAdapter), true);
        allowlist.setToken(address(asset), true);
        allowlist.setToken(address(vault), true); // the share token IS the vault address

        asset.mint(user, 1_000_000 ether);
        asset.mint(griefer, 1_000_000 ether);
    }

    // ------------------------------------------------------------------ //
    // Wiring                                                             //
    // ------------------------------------------------------------------ //

    function test_adaptersAreWeldedToOneVaultAndItsAsset() public view {
        assertEq(depositAdapter.vault(), address(vault));
        assertEq(depositAdapter.asset(), address(asset));
        assertEq(redeemAdapter.vault(), address(vault));
        assertEq(redeemAdapter.asset(), address(asset));
    }

    // ------------------------------------------------------------------ //
    // Deposit: shares land on the caller, never on the adapter            //
    // ------------------------------------------------------------------ //

    function test_depositMintsSharesToTheCallerAndNotToTheAdapter() public {
        uint256 expected = vault.previewDeposit(DEPOSIT_ASSETS);
        assertGt(expected, 0);

        vm.prank(user);
        asset.approve(address(depositAdapter), DEPOSIT_ASSETS);
        vm.prank(user);
        (address tokenOut, uint256 amountOut) = depositAdapter.execute(address(asset), DEPOSIT_ASSETS, "");

        assertEq(tokenOut, address(vault), "tokenOut must be the share token");
        assertEq(amountOut, expected, "amountOut must equal the vault's own pricing");
        // The whole point: the SHARES are the caller's, not the adapter's.
        assertEq(vault.balanceOf(user), amountOut, "shares did not land on the caller");
        assertEq(vault.balanceOf(address(depositAdapter)), 0, "adapter became the shareholder");
        // and nothing is left behind anywhere.
        assertEq(asset.balanceOf(address(depositAdapter)), 0, "asset dust on the adapter");
        assertEq(asset.allowance(address(depositAdapter), address(vault)), 0, "residual allowance to the vault");
        assertEq(asset.balanceOf(address(vault)), DEPOSIT_ASSETS);
    }

    /// @dev The return value must be a MEASURED delta, which only a caller that already holds shares
    ///      can distinguish from "whatever the vault said".
    function test_depositMeasuredDeltaEqualsReturnValueWhenTheCallerAlreadyHoldsShares() public {
        _depositAs(user, DEPOSIT_ASSETS);
        uint256 sharesBefore = vault.balanceOf(user);
        assertGt(sharesBefore, 0);

        uint256 expected = vault.previewDeposit(DEPOSIT_ASSETS);
        vm.prank(user);
        asset.approve(address(depositAdapter), DEPOSIT_ASSETS);
        vm.prank(user);
        (, uint256 amountOut) = depositAdapter.execute(address(asset), DEPOSIT_ASSETS, "");

        assertEq(vault.balanceOf(user) - sharesBefore, amountOut, "return value != measured delta");
        assertEq(amountOut, expected);
        assertEq(vault.balanceOf(address(depositAdapter)), 0);
    }

    /// @dev A donation to this adapter must never be laundered into somebody's output.
    function test_depositIgnoresAssetDonatedToTheAdapter() public {
        vm.prank(griefer);
        asset.transfer(address(depositAdapter), 5 ether);

        vm.prank(user);
        asset.approve(address(depositAdapter), DEPOSIT_ASSETS);
        vm.prank(user);
        // The adapter measures its own input delta and requires it restored exactly, so the stray
        // 5 ether is neither deposited nor swept — it is simply not part of this call.
        (, uint256 amountOut) = depositAdapter.execute(address(asset), DEPOSIT_ASSETS, "");

        assertEq(vault.balanceOf(user), amountOut);
        assertEq(asset.balanceOf(address(depositAdapter)), 5 ether, "donation must be untouched");
        assertEq(asset.balanceOf(address(vault)), DEPOSIT_ASSETS, "donation must not have been deposited");
    }

    function test_depositEnforcesMinSharesOut() public {
        uint256 expected = vault.previewDeposit(DEPOSIT_ASSETS);

        vm.prank(user);
        asset.approve(address(depositAdapter), DEPOSIT_ASSETS);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(ZapVaultDepositAdapter.InsufficientOutput.selector, expected + 1, expected)
        );
        depositAdapter.execute(address(asset), DEPOSIT_ASSETS, abi.encode(expected + 1));

        vm.prank(user);
        (, uint256 amountOut) = depositAdapter.execute(address(asset), DEPOSIT_ASSETS, abi.encode(expected));
        assertEq(amountOut, expected);
    }

    function test_depositRejectsWrongTokenIn() public {
        MockERC20 other = new MockERC20("Other", "OTHER", 18);
        vm.expectRevert(abi.encodeWithSelector(ZapVaultDepositAdapter.UnsupportedToken.selector, address(other)));
        depositAdapter.execute(address(other), 1 ether, "");

        // Notably including the share token: this adapter is the deposit leg and nothing else.
        vm.expectRevert(abi.encodeWithSelector(ZapVaultDepositAdapter.UnsupportedToken.selector, address(vault)));
        depositAdapter.execute(address(vault), 1 ether, "");
    }

    function test_depositRejectsZeroAmountAndMalformedData() public {
        vm.expectRevert(ZapVaultDepositAdapter.ZeroAmount.selector);
        depositAdapter.execute(address(asset), 0, "");

        vm.expectRevert(ZapVaultDepositAdapter.InvalidData.selector);
        depositAdapter.execute(address(asset), 1 ether, hex"01");
    }

    /// @dev The `ZeroShares` edge, surfaced through the adapter as a clean revert — and the proof
    ///      that a failed step leaves neither an allowance nor dust behind.
    function test_depositSurfacesZeroSharesCleanlyAndLeavesNoAllowanceOrDust() public {
        // Inflate the share price so a small deposit rounds to zero shares.
        vm.prank(griefer);
        asset.transfer(address(vault), 1_000 ether);

        uint256 tiny = 0.1 ether; // 0.1e18 * 1000 < 1000e18 + 1  =>  0 shares
        assertEq(vault.previewDeposit(tiny), 0, "test setup no longer reaches the ZeroShares edge");

        vm.prank(user);
        asset.approve(address(depositAdapter), tiny);
        uint256 userAssetBefore = asset.balanceOf(user);

        vm.prank(user);
        (bool ok, bytes memory ret) =
            address(depositAdapter).call(abi.encodeCall(IAdapter.execute, (address(asset), tiny, bytes(""))));

        assertFalse(ok, "a zero-share deposit must not succeed");
        assertEq(ret, abi.encodeWithSelector(ZapVault.ZeroShares.selector, tiny), "wrong revert surfaced");
        assertEq(asset.balanceOf(user), userAssetBefore, "principal must not have moved");
        assertEq(asset.allowance(address(depositAdapter), address(vault)), 0, "residual allowance after revert");
        assertEq(asset.balanceOf(address(depositAdapter)), 0, "dust on the adapter after revert");
        assertEq(vault.balanceOf(address(depositAdapter)), 0);
    }

    /// @dev The reentrant payload deliberately names a tokenIn this adapter would REJECT. The guard is
    ///      the very first statement in `execute`, ahead of the token check, so seeing `Reentrancy()`
    ///      rather than `UnsupportedToken(...)` proves it was this adapter's own guard that refused —
    ///      not the vault's, and not an incidental failure further down.
    function test_depositRefusesReentrancy() public {
        (CallbackERC20 hostile, ZapVault hostileVault, ZapVaultDepositAdapter hostileDeposit,) = _hostileFixture();

        hostile.mint(user, 10 ether);
        vm.prank(user);
        hostile.approve(address(hostileDeposit), 10 ether);

        // Reenter during the adapter's own pull of the input asset.
        hostile.arm(address(hostileDeposit), abi.encodeCall(IAdapter.execute, (address(hostileVault), 1, bytes(""))));

        vm.prank(user);
        hostileDeposit.execute(address(hostile), 10 ether, "");

        assertFalse(hostile.lastCallSucceeded(), "reentrant call was allowed");
        assertEq(
            hostile.lastReturnData(),
            abi.encodeWithSelector(ZapVaultDepositAdapter.Reentrancy.selector),
            "not stopped by the adapter's guard"
        );
    }

    function test_depositConstructorRefusals() public {
        vm.expectRevert(ZapVaultDepositAdapter.ZeroAddress.selector);
        new ZapVaultDepositAdapter(address(0));

        vm.expectRevert(abi.encodeWithSelector(ZapVaultDepositAdapter.NoCode.selector, user));
        new ZapVaultDepositAdapter(user);

        vm.chainId(31337);
        vm.expectRevert(abi.encodeWithSelector(ZapVaultDepositAdapter.WrongChain.selector, 31337));
        new ZapVaultDepositAdapter(address(vault));
    }

    function test_depositRefusesToRunOffRobinhoodChain() public {
        vm.prank(user);
        asset.approve(address(depositAdapter), DEPOSIT_ASSETS);
        vm.chainId(8453);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ZapVaultDepositAdapter.WrongChain.selector, 8453));
        depositAdapter.execute(address(asset), DEPOSIT_ASSETS, "");
    }

    // ------------------------------------------------------------------ //
    // Redeem: shares burned from the caller, assets paid to the caller    //
    // ------------------------------------------------------------------ //

    function test_redeemBurnsTheCallersSharesAndPaysTheCaller() public {
        uint256 shares = _depositAs(user, DEPOSIT_ASSETS);
        uint256 expectedAssets = vault.previewRedeem(shares);
        uint256 assetBefore = asset.balanceOf(user);

        // Exactly the approval OpenZap.execute emits for a step: approve(adapter, amountIn) on tokenIn.
        vm.prank(user);
        vault.approve(address(redeemAdapter), shares);

        vm.prank(user);
        (address tokenOut, uint256 amountOut) = redeemAdapter.execute(address(vault), shares, "");

        assertEq(tokenOut, address(asset), "tokenOut must be the underlying");
        assertEq(amountOut, expectedAssets);
        assertEq(asset.balanceOf(user) - assetBefore, amountOut, "return value != measured delta");
        assertEq(vault.balanceOf(user), 0, "shares were not burned from the caller");
        // The adapter never took custody of either side and left no allowance of its own.
        assertEq(vault.balanceOf(address(redeemAdapter)), 0, "shares routed through the adapter");
        assertEq(asset.balanceOf(address(redeemAdapter)), 0, "asset dust on the adapter");
        assertEq(vault.allowance(user, address(redeemAdapter)), 0, "allowance not fully consumed");
    }

    /// @dev The allowance is load-bearing, not incidental: this is the whole reason the redeem leg is
    ///      expressible under `IAdapter` while the Aave borrow leg is not.
    function test_redeemRevertsWithoutTheZapsAllowance() public {
        uint256 shares = _depositAs(user, DEPOSIT_ASSETS);

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(ZapVault.InsufficientAllowance.selector, user, address(redeemAdapter), 0, shares)
        );
        redeemAdapter.execute(address(vault), shares, "");
    }

    /// @notice Why the adapter uses `redeem` and not `withdraw`, proved rather than asserted.
    /// @dev `Step.amountIn` is one frozen constant that is BOTH the quantity the adapter passes to
    ///      the vault AND the exact size of the allowance `OpenZap.execute` grants. `withdraw` is
    ///      denominated in assets but spends an allowance denominated in shares, so those two uses of
    ///      the same number are in different units and cannot line up: here a 10 ether withdraw needs
    ///      1e22 shares of allowance while the step granted 1e19. `redeem` is denominated in shares,
    ///      so `amountIn` shares in spends exactly `amountIn` of allowance, always.
    function test_redeemIsTheOnlyEntryPointAStepCanAuthorise() public {
        _depositAs(user, DEPOSIT_ASSETS);
        uint256 amountIn = 10 ether; // what a `withdraw`-shaped step would freeze into the policy
        address spender = address(this); // stands in for the adapter

        // Exactly what OpenZap grants for a step: approve(adapter, amountIn) on tokenIn.
        vm.prank(user);
        vault.approve(spender, amountIn);

        uint256 sharesNeeded = vault.previewWithdraw(amountIn);
        assertEq(sharesNeeded, 1e22, "share pricing moved");
        vm.expectRevert(
            abi.encodeWithSelector(ZapVault.InsufficientAllowance.selector, user, spender, amountIn, sharesNeeded)
        );
        vault.withdraw(amountIn, user, user);

        // The same frozen `amountIn`, read as shares, is authorised to the wei.
        vault.redeem(amountIn, user, user);
        assertEq(vault.allowance(user, spender), 0, "redeem must consume exactly the step's allowance");
    }

    /// @dev Bounded consumption without taking custody: a caller who over-approves still loses only
    ///      the share count the step named.
    function test_redeemConsumesOnlyTheNamedShareCount() public {
        uint256 shares = _depositAs(user, DEPOSIT_ASSETS);
        uint256 half = shares / 2;

        vm.prank(user);
        vault.approve(address(redeemAdapter), shares); // deliberately more than the step spends

        vm.prank(user);
        redeemAdapter.execute(address(vault), half, "");

        assertEq(vault.balanceOf(user), shares - half, "burned more than the named amount");
        assertEq(vault.allowance(user, address(redeemAdapter)), shares - half, "spent more allowance than named");
        assertEq(vault.balanceOf(address(redeemAdapter)), 0);
        assertEq(asset.balanceOf(address(redeemAdapter)), 0);
    }

    function test_redeemIgnoresAssetDonatedToTheAdapter() public {
        uint256 shares = _depositAs(user, DEPOSIT_ASSETS);
        vm.prank(griefer);
        asset.transfer(address(redeemAdapter), 5 ether);

        vm.prank(user);
        vault.approve(address(redeemAdapter), shares);
        vm.prank(user);
        (, uint256 amountOut) = redeemAdapter.execute(address(vault), shares, "");

        assertEq(amountOut, DEPOSIT_ASSETS);
        assertEq(asset.balanceOf(address(redeemAdapter)), 5 ether, "donation must be untouched");
    }

    function test_redeemEnforcesMinAssetsOut() public {
        uint256 shares = _depositAs(user, DEPOSIT_ASSETS);
        uint256 expected = vault.previewRedeem(shares);

        vm.prank(user);
        vault.approve(address(redeemAdapter), shares);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(ZapVaultRedeemAdapter.InsufficientOutput.selector, expected + 1, expected)
        );
        redeemAdapter.execute(address(vault), shares, abi.encode(expected + 1));
    }

    function test_redeemRejectsWrongTokenIn() public {
        vm.expectRevert(abi.encodeWithSelector(ZapVaultRedeemAdapter.UnsupportedToken.selector, address(asset)));
        redeemAdapter.execute(address(asset), 1 ether, "");
    }

    function test_redeemRejectsZeroAmountAndMalformedData() public {
        vm.expectRevert(ZapVaultRedeemAdapter.ZeroAmount.selector);
        redeemAdapter.execute(address(vault), 0, "");

        vm.expectRevert(ZapVaultRedeemAdapter.InvalidData.selector);
        redeemAdapter.execute(address(vault), 1 ether, hex"01");
    }

    /// @dev The `ZeroAssets` edge, surfaced through the adapter as a clean revert. A 1 wei deposit
    ///      mints 1000 shares; redeeming 999 of them prices to zero assets, and the vault refuses to
    ///      burn them for nothing rather than silently confiscating.
    function test_redeemSurfacesZeroAssetsCleanly() public {
        uint256 shares = _depositAs(user, 1);
        assertEq(shares, 1_000);
        assertEq(vault.previewRedeem(999), 0, "test setup no longer reaches the ZeroAssets edge");

        vm.prank(user);
        vault.approve(address(redeemAdapter), 999);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ZapVault.ZeroAssets.selector, uint256(999)));
        redeemAdapter.execute(address(vault), 999, "");

        assertEq(vault.balanceOf(user), 1_000, "shares must survive the refusal");
    }

    function test_redeemRefusesReentrancy() public {
        (CallbackERC20 hostile, ZapVault hostileVault,, ZapVaultRedeemAdapter hostileRedeem) = _hostileFixture();

        hostile.mint(user, 10 ether);
        vm.startPrank(user);
        hostile.approve(address(hostileVault), 10 ether);
        uint256 shares = hostileVault.deposit(10 ether, user);
        hostileVault.approve(address(hostileRedeem), shares);
        vm.stopPrank();

        // Reenter during the vault's payout leg, i.e. inside the adapter's own call. As above, the
        // payload names a tokenIn this adapter rejects, so `Reentrancy()` can only have come from the
        // adapter's guard — `ZapVault`'s identically-named guard is never reached on this path.
        hostile.arm(address(hostileRedeem), abi.encodeCall(IAdapter.execute, (address(hostile), 1, bytes(""))));

        vm.prank(user);
        hostileRedeem.execute(address(hostileVault), shares, "");

        assertFalse(hostile.lastCallSucceeded(), "reentrant call was allowed");
        assertEq(
            hostile.lastReturnData(),
            abi.encodeWithSelector(ZapVaultRedeemAdapter.Reentrancy.selector),
            "not stopped by the adapter's guard"
        );
    }

    function test_redeemConstructorRefusals() public {
        vm.expectRevert(ZapVaultRedeemAdapter.ZeroAddress.selector);
        new ZapVaultRedeemAdapter(address(0));

        vm.expectRevert(abi.encodeWithSelector(ZapVaultRedeemAdapter.NoCode.selector, user));
        new ZapVaultRedeemAdapter(user);

        vm.chainId(31337);
        vm.expectRevert(abi.encodeWithSelector(ZapVaultRedeemAdapter.WrongChain.selector, 31337));
        new ZapVaultRedeemAdapter(address(vault));
    }

    function test_redeemRefusesToRunOffRobinhoodChain() public {
        uint256 shares = _depositAs(user, DEPOSIT_ASSETS);
        vm.prank(user);
        vault.approve(address(redeemAdapter), shares);
        vm.chainId(8453);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ZapVaultRedeemAdapter.WrongChain.selector, 8453));
        redeemAdapter.execute(address(vault), shares, "");
    }

    // ------------------------------------------------------------------ //
    // End to end through real OpenZap clones                              //
    // ------------------------------------------------------------------ //

    /// @notice The deliverable: asset -> vault shares -> asset, entirely inside frozen policies
    ///         executed by real `OpenZap` clones from the real factory.
    /// @dev Two clones, not one, and that is not a workaround — see
    ///      `test_oneCloneCannotDepositAndRedeemInASingleExecution` for why the settlement rule makes
    ///      a self-financed round trip inside one run worth exactly zero.
    ///
    ///      The redeem clone is what proves the interesting claim: `OpenZap.execute`'s only approval
    ///      primitive is `approve(spender == adapter, amountIn)` on the step's `tokenIn`, and for the
    ///      redeem step `tokenIn` is the share token, so that single call IS the ERC-4626 allowance
    ///      `redeem(shares, receiver, owner)` requires. No core change, no delegation primitive.
    function test_roundTripThroughRealOpenZapClones() public {
        // The frozen constant has to be right before either policy can be written.
        assertEq(vault.previewDeposit(DEPOSIT_ASSETS), EXPECTED_SHARES, "share pricing moved");

        // ---- clone B: shares in, asset out, paid to the final recipient ----
        OpenZap unwindZap = _createZap(
            finalRecipient,
            _step(address(redeemAdapter), address(vault), EXPECTED_SHARES, abi.encode(DEPOSIT_ASSETS)),
            bytes32("unwind")
        );

        // ---- clone A: asset in, shares out, paid to clone B ----
        OpenZap supplyZap = _createZap(
            address(unwindZap),
            _step(address(depositAdapter), address(asset), DEPOSIT_ASSETS, abi.encode(EXPECTED_SHARES)),
            bytes32("supply")
        );
        asset.mint(address(supplyZap), DEPOSIT_ASSETS);

        _run(supplyZap, 1, address(vault), EXPECTED_SHARES);

        assertEq(vault.balanceOf(address(unwindZap)), EXPECTED_SHARES, "shares did not settle to the recipient");
        assertEq(vault.balanceOf(address(supplyZap)), 0);
        assertEq(vault.balanceOf(address(depositAdapter)), 0, "adapter became the shareholder");
        assertEq(asset.balanceOf(address(supplyZap)), 0, "asset stranded in the supply zap");
        assertEq(asset.balanceOf(address(depositAdapter)), 0);
        assertEq(asset.allowance(address(supplyZap), address(depositAdapter)), 0, "step approval not revoked");
        assertEq(asset.balanceOf(address(vault)), DEPOSIT_ASSETS);

        _run(unwindZap, 1, address(asset), DEPOSIT_ASSETS);

        assertEq(asset.balanceOf(finalRecipient), DEPOSIT_ASSETS, "round trip did not return the principal");
        assertEq(vault.balanceOf(address(unwindZap)), 0, "shares stranded in the unwind zap");
        assertEq(vault.allowance(address(unwindZap), address(redeemAdapter)), 0, "step approval not revoked");
        assertEq(vault.balanceOf(address(redeemAdapter)), 0);
        assertEq(asset.balanceOf(address(redeemAdapter)), 0);
        assertEq(vault.totalSupply(), 0, "vault did not fully unwind");
        assertEq(asset.balanceOf(address(vault)), 0);
    }

    /// @notice Why the round trip needs two clones. `OpenZap.execute` snapshots
    ///         `balanceOf(outAsset)` BEFORE the loop and settles the delta, so a deposit-then-redeem
    ///         inside one run spends and returns the same principal and nets zero — it cannot satisfy
    ///         any positive `minOut`, and with `minOut == 0` it pays the recipient nothing. This is
    ///         the single-asset settlement rule doing exactly what it is supposed to, not a bug in
    ///         these adapters.
    function test_oneCloneCannotDepositAndRedeemInASingleExecution() public {
        Step[] memory steps = new Step[](2);
        steps[0] = _step(address(depositAdapter), address(asset), DEPOSIT_ASSETS, "");
        steps[1] = _step(address(redeemAdapter), address(vault), EXPECTED_SHARES, "");

        OpenZap zap = _createZapWithSteps(finalRecipient, steps, bytes32("round-trip-in-one"));
        asset.mint(address(zap), DEPOSIT_ASSETS);

        // Any positive min-out is unreachable: the run is value-neutral by construction.
        OpenZapIntent memory it = _intent(zap, 1, address(asset), 1);
        vm.expectRevert(OpenZap.MinOutNotMet.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));

        // With minOut == 0 the steps do run — and settle nothing, leaving the principal in the zap
        // where only `emergencyExit` can retrieve it. Surplus is recoverable, never automatic.
        it = _intent(zap, 2, address(asset), 0);
        zap.execute(it, _signIntent(OWNER_PK, it));

        assertEq(asset.balanceOf(finalRecipient), 0, "a value-neutral run must not pay out");
        assertEq(asset.balanceOf(address(zap)), DEPOSIT_ASSETS, "principal should be back in the zap");
        assertEq(vault.balanceOf(address(zap)), 0);

        address[] memory sweep = new address[](1);
        sweep[0] = address(asset);
        vm.prank(owner);
        zap.emergencyExit(sweep);
        assertEq(asset.balanceOf(owner), DEPOSIT_ASSETS, "owner could not recover the stranded principal");
    }

    // ------------------------------------------------------------------ //
    // Helpers                                                            //
    // ------------------------------------------------------------------ //

    function _depositAs(address who, uint256 assets) private returns (uint256 shares) {
        vm.prank(who);
        asset.approve(address(vault), assets);
        vm.prank(who);
        shares = vault.deposit(assets, who);
    }

    /// @dev A separate vault + adapter pair over a callback-on-transfer asset, for the guard tests.
    function _hostileFixture()
        private
        returns (CallbackERC20 hostile, ZapVault hostileVault, ZapVaultDepositAdapter dep, ZapVaultRedeemAdapter red)
    {
        hostile = new CallbackERC20();
        hostileVault = new ZapVault(address(hostile), "Hostile", "HV");
        dep = new ZapVaultDepositAdapter(address(hostileVault));
        red = new ZapVaultRedeemAdapter(address(hostileVault));
    }

    function _step(address adapter_, address tokenIn_, uint256 amountIn_, bytes memory data_)
        private
        pure
        returns (Step memory)
    {
        return Step({adapter: adapter_, tokenIn: tokenIn_, spender: adapter_, amountIn: amountIn_, data: data_});
    }

    function _createZap(address recipient_, Step memory s, bytes32 salt) private returns (OpenZap) {
        Step[] memory steps = new Step[](1);
        steps[0] = s;
        return _createZapWithSteps(recipient_, steps, salt);
    }

    function _createZapWithSteps(address recipient_, Step[] memory steps, bytes32 salt) private returns (OpenZap) {
        address[] memory tracked = new address[](2);
        tracked[0] = address(asset);
        tracked[1] = address(vault);

        Policy memory p = Policy({
            owner: owner,
            recipient: recipient_,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
        return OpenZap(payable(factory.createZap(p, salt)));
    }

    function _intent(OpenZap zap, uint256 nonce, address outAsset, uint256 minOut)
        private
        view
        returns (OpenZapIntent memory)
    {
        return OpenZapIntent({
            zap: address(zap),
            chainId: block.chainid,
            nonce: nonce,
            validAfter: 0,
            deadline: uint64(block.timestamp + 1 hours),
            recipient: zap.recipient(),
            relayer: address(0),
            maxRelayerFee: 0,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: outAsset,
            minOut: minOut
        });
    }

    function _run(OpenZap zap, uint256 nonce, address outAsset, uint256 minOut) private {
        OpenZapIntent memory it = _intent(zap, nonce, outAsset, minOut);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function _digest(OpenZapIntent memory it) private view returns (bytes32) {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("1"), block.chainid, it.zap));
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                it.zap,
                it.chainId,
                it.nonce,
                it.validAfter,
                it.deadline,
                it.recipient,
                it.relayer,
                it.maxRelayerFee,
                it.maxGas,
                it.maxFeePerGas,
                it.policyHash,
                it.outAsset,
                it.minOut
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _signIntent(uint256 pk, OpenZapIntent memory it) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(it));
        return abi.encodePacked(r, s, v);
    }
}
