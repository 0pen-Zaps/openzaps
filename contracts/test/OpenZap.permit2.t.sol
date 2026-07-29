// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseTest} from "./Base.t.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {IAdapter} from "../src/interfaces/IAdapter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IPermit2SignatureTransfer} from "../src/interfaces/IPermit2SignatureTransfer.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";
import {MockFeeOnTransferERC20} from "./mocks/MockFeeOnTransferERC20.sol";
import {MockPermit2SignatureTransfer} from "./mocks/MockPermit2SignatureTransfer.sol";

contract TogglePermit2Adapter is IAdapter {
    bool public shouldRevert = true;

    error ForcedRevert();

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        returns (address tokenOut, uint256 amountOut)
    {
        if (shouldRevert) revert ForcedRevert();
        (tokenOut, amountOut) = abi.decode(data, (address, uint256));
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(msg.sender, amountOut);
    }
}

contract PartialPullAdapter is IAdapter {
    function execute(address tokenIn, uint256 amountIn, bytes calldata data)
        external
        returns (address tokenOut, uint256 amountOut)
    {
        (tokenOut, amountOut) = abi.decode(data, (address, uint256));
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn / 2);
        IERC20(tokenOut).transfer(msg.sender, amountOut);
    }
}

/// @notice ADR-0001 Permit2 owner-pull path: owner is the only asset source; the capsule is the
///         implicit spender and fixed destination; token/amount/witness/deadline all fail closed.
contract Permit2OwnerPullTest is BaseTest {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 internal constant PERMIT2_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant OPENZAP_WITNESS_TYPEHASH = keccak256("OpenZapIntentWitness(bytes32 intentDigest)");
    string internal constant WITNESS_TYPE_STRING =
        "OpenZapIntentWitness witness)OpenZapIntentWitness(bytes32 intentDigest)TokenPermissions(address token,uint256 amount)";

    MockPermit2SignatureTransfer internal permit2;

    function setUp() public override {
        super.setUp();

        MockPermit2SignatureTransfer permit2Runtime = new MockPermit2SignatureTransfer();
        vm.etch(PERMIT2, address(permit2Runtime).code);
        permit2 = MockPermit2SignatureTransfer(PERMIT2);

        // The fixture is deposit-funded. Return that input to the owner so every test starts with an
        // unfunded capsule and can prove the only new funding came through SignatureTransfer.
        address[] memory assets = new address[](1);
        assets[0] = address(tokenIn);
        vm.prank(owner);
        zap.emergencyExit(assets);

        vm.prank(owner);
        tokenIn.approve(PERMIT2, type(uint256).max);
    }

    function test_happyPath_pullsFromOwnerAndExecutesWithoutExecutorAuthority() public {
        OpenZapIntent memory intent = _defaultIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 41);

        vm.prank(relayer);
        zap.executeWithPermit2(
            intent,
            permit,
            _signIntent(OWNER_PK, intent),
            _signPermit(OWNER_PK, permit, address(zap), _witness(intent, address(zap)))
        );

        assertEq(tokenIn.balanceOf(owner), 0, "owner funded exactly one step");
        assertEq(tokenIn.balanceOf(address(zap)), 0, "no pulled input retained");
        assertEq(tokenOut.balanceOf(recipient), 99e18, "recipient net");
        assertEq(tokenOut.balanceOf(relayer), 1e18, "signed fee");
        assertEq(tokenIn.allowance(owner, relayer), 0, "executor never receives pull allowance");
        assertEq(tokenIn.allowance(address(zap), address(adapter)), 0, "adapter approval reset");
        assertTrue(zap.nonceUsed(intent.nonce), "OpenZap nonce consumed");
        assertTrue(_permitNonceUsed(owner, permit.nonce), "Permit2 nonce consumed");
    }

    function test_candidateVersionKeepsIntentDomainVersionOne() public view {
        assertEq(factory.VERSION(), "1.2.0-candidate", "runtime lineage must be explicit");
        bytes32 expectedDomain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("1"), block.chainid, address(zap)));
        assertEq(zap.domainSeparator(), expectedDomain, "base intent schema remains domain v1");
    }

    function test_relayerCannotRedirectOrSpendTheOwnerPermit() public {
        OpenZapIntent memory intent = _defaultIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 42);
        bytes32 witness = _witness(intent, address(zap));
        bytes memory permitSig = _signPermit(OWNER_PK, permit, address(zap), witness);

        vm.prank(relayer);
        vm.expectRevert(MockPermit2SignatureTransfer.InvalidSignature.selector);
        permit2.permitWitnessTransferFrom(
            permit,
            IPermit2SignatureTransfer.SignatureTransferDetails({to: relayer, requestedAmount: AMOUNT_IN}),
            owner,
            witness,
            WITNESS_TYPE_STRING,
            permitSig
        );

        assertFalse(_permitNonceUsed(owner, permit.nonce), "failed theft cannot consume permit");
        zap.executeWithPermit2(intent, permit, _signIntent(OWNER_PK, intent), permitSig);
        assertEq(tokenOut.balanceOf(recipient), 99e18, "original capsule-bound permit remains usable");
    }

    function test_wrongPermitTokenOrAmountFailsBeforeAuthorization() public {
        OpenZapIntent memory intent = _defaultIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 43);

        permit.permitted.token = address(tokenOut);
        vm.expectRevert(
            abi.encodeWithSelector(OpenZap.Permit2TokenMismatch.selector, address(tokenIn), address(tokenOut))
        );
        zap.executeWithPermit2(intent, permit, "", "");
        assertFalse(zap.nonceUsed(intent.nonce));

        permit = _permit(intent, 44);
        permit.permitted.amount = AMOUNT_IN - 1;
        vm.expectRevert(abi.encodeWithSelector(OpenZap.Permit2AmountMismatch.selector, AMOUNT_IN, AMOUNT_IN - 1));
        zap.executeWithPermit2(intent, permit, "", "");
        assertFalse(zap.nonceUsed(intent.nonce));
    }

    function test_permitMustWitnessTheExactOpenZapIntent() public {
        OpenZapIntent memory intent = _defaultIntent();
        OpenZapIntent memory foreignIntent = _defaultIntent();
        foreignIntent.nonce = intent.nonce + 1;
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 45);

        bytes memory wrongWitnessSig =
            _signPermit(OWNER_PK, permit, address(zap), _witness(foreignIntent, address(zap)));
        vm.expectRevert(MockPermit2SignatureTransfer.InvalidSignature.selector);
        zap.executeWithPermit2(intent, permit, _signIntent(OWNER_PK, intent), wrongWitnessSig);

        assertFalse(zap.nonceUsed(intent.nonce), "reverted witness verification rolls nonce back");
        assertFalse(_permitNonceUsed(owner, permit.nonce), "reverted witness verification rolls permit back");
        assertEq(tokenIn.balanceOf(owner), AMOUNT_IN, "no owner funds moved");
    }

    function test_permitDeadlineIsShortAndNoLaterThanIntent() public {
        OpenZapIntent memory intent = _defaultIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 46);

        permit.deadline = uint256(intent.deadline) + 1;
        vm.expectRevert(OpenZap.Permit2DeadlineBeyondIntent.selector);
        zap.executeWithPermit2(intent, permit, "", "");

        intent.deadline = uint64(block.timestamp + 2 hours);
        permit = _permit(intent, 47);
        vm.expectRevert(OpenZap.Permit2DeadlineTooLong.selector);
        zap.executeWithPermit2(intent, permit, "", "");

        intent = _defaultIntent();
        permit = _permit(intent, 48);
        permit.deadline = block.timestamp - 1;
        vm.expectRevert(OpenZap.Permit2Expired.selector);
        zap.executeWithPermit2(intent, permit, "", "");
        assertFalse(zap.nonceUsed(intent.nonce));
    }

    function test_policyAndOwnerIntentAreCheckedBeforeThePull() public {
        OpenZapIntent memory intent = _defaultIntent();
        intent.policyHash = bytes32(uint256(0xdead));
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 49);

        vm.expectRevert(OpenZap.PolicyMismatch.selector);
        zap.executeWithPermit2(
            intent,
            permit,
            _signIntent(OWNER_PK, intent),
            _signPermit(OWNER_PK, permit, address(zap), _witness(intent, address(zap)))
        );
        assertEq(tokenIn.balanceOf(owner), AMOUNT_IN);
        assertFalse(_permitNonceUsed(owner, permit.nonce));
    }

    function test_permitAndOpenZapReplayProtectionAreIndependent() public {
        OpenZapIntent memory intent = _defaultIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 50);
        bytes memory intentSig = _signIntent(OWNER_PK, intent);
        bytes memory permitSig = _signPermit(OWNER_PK, permit, address(zap), _witness(intent, address(zap)));

        zap.executeWithPermit2(intent, permit, intentSig, permitSig);

        vm.expectRevert(OpenZap.NonceReplay.selector);
        zap.executeWithPermit2(intent, permit, intentSig, permitSig);

        tokenIn.mint(owner, AMOUNT_IN);
        OpenZapIntent memory nextIntent = _defaultIntent();
        nextIntent.nonce = intent.nonce + 1;
        IPermit2SignatureTransfer.PermitTransferFrom memory replayedPermit = _permit(nextIntent, permit.nonce);
        bytes memory replayedPermitSig =
            _signPermit(OWNER_PK, replayedPermit, address(zap), _witness(nextIntent, address(zap)));

        vm.expectRevert(MockPermit2SignatureTransfer.InvalidNonce.selector);
        zap.executeWithPermit2(nextIntent, replayedPermit, _signIntent(OWNER_PK, nextIntent), replayedPermitSig);
        assertFalse(zap.nonceUsed(nextIntent.nonce), "Permit2 replay revert rolls OpenZap nonce back");
    }

    function test_adapterRevertAtomicallyRollsBackPullAndBothNonces() public {
        TogglePermit2Adapter toggle = new TogglePermit2Adapter();
        registry.setAdapter(address(toggle), true);
        tokenOut.mint(address(toggle), AMOUNT_IN);

        Policy memory policy = _defaultPolicy();
        policy.steps[0].adapter = address(toggle);
        policy.steps[0].spender = address(toggle);
        policy.steps[0].data = abi.encode(address(tokenOut), AMOUNT_IN);
        OpenZap retryZap = OpenZap(payable(factory.createZap(policy, bytes32("permit-retry"))));

        OpenZapIntent memory intent = _intentFor(retryZap);
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 51);
        bytes memory intentSig = _signIntent(OWNER_PK, intent);
        bytes memory permitSig = _signPermit(OWNER_PK, permit, address(retryZap), _witness(intent, address(retryZap)));

        vm.expectRevert(TogglePermit2Adapter.ForcedRevert.selector);
        retryZap.executeWithPermit2(intent, permit, intentSig, permitSig);
        assertEq(tokenIn.balanceOf(owner), AMOUNT_IN, "pull rolled back");
        assertFalse(retryZap.nonceUsed(intent.nonce), "OpenZap nonce rolled back");
        assertFalse(_permitNonceUsed(owner, permit.nonce), "Permit2 nonce rolled back");
        assertEq(tokenIn.allowance(address(retryZap), address(toggle)), 0, "approval rolled back");

        toggle.setShouldRevert(false);
        retryZap.executeWithPermit2(intent, permit, intentSig, permitSig);
        assertEq(tokenOut.balanceOf(recipient), 99e18, "same signatures retry atomically");
    }

    function test_partialInputConsumptionFailsClosedAndRollsThePullBack() public {
        PartialPullAdapter partialAdapter = new PartialPullAdapter();
        registry.setAdapter(address(partialAdapter), true);
        tokenOut.mint(address(partialAdapter), AMOUNT_IN);

        Policy memory policy = _defaultPolicy();
        policy.steps[0].adapter = address(partialAdapter);
        policy.steps[0].spender = address(partialAdapter);
        policy.steps[0].data = abi.encode(address(tokenOut), AMOUNT_IN);
        OpenZap partialZap = OpenZap(payable(factory.createZap(policy, bytes32("permit-partial"))));

        OpenZapIntent memory intent = _intentFor(partialZap);
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 52);
        vm.expectRevert(abi.encodeWithSelector(OpenZap.Permit2PullNotConsumed.selector, AMOUNT_IN / 2));
        partialZap.executeWithPermit2(
            intent,
            permit,
            _signIntent(OWNER_PK, intent),
            _signPermit(OWNER_PK, permit, address(partialZap), _witness(intent, address(partialZap)))
        );

        assertEq(tokenIn.balanceOf(owner), AMOUNT_IN, "partial pull path fully rolled back");
        assertEq(tokenIn.balanceOf(address(partialZap)), 0);
        assertFalse(_permitNonceUsed(owner, permit.nonce));
    }

    function test_feeOnTransferPullFailsMeasuredDeltaAndRollsBack() public {
        MockFeeOnTransferERC20 taxedToken = new MockFeeOnTransferERC20();
        allowlist.setToken(address(taxedToken), true); // simulate a governance admission mistake

        Policy memory policy = _defaultPolicy();
        policy.trackedAssets[0] = address(taxedToken);
        policy.steps[0].tokenIn = address(taxedToken);
        OpenZap taxedZap = OpenZap(payable(factory.createZap(policy, bytes32("permit-fot"))));

        taxedToken.mint(owner, AMOUNT_IN);
        vm.prank(owner);
        taxedToken.approve(PERMIT2, type(uint256).max);

        OpenZapIntent memory intent = _intentFor(taxedZap);
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 56);
        uint256 receivedAfterFee = AMOUNT_IN - (AMOUNT_IN * taxedToken.FEE_BPS()) / 10_000;

        vm.expectRevert(abi.encodeWithSelector(OpenZap.Permit2PullAmountMismatch.selector, AMOUNT_IN, receivedAfterFee));
        taxedZap.executeWithPermit2(
            intent,
            permit,
            _signIntent(OWNER_PK, intent),
            _signPermit(OWNER_PK, permit, address(taxedZap), _witness(intent, address(taxedZap)))
        );

        assertEq(taxedToken.balanceOf(owner), AMOUNT_IN, "taxed transfer rolled back");
        assertEq(taxedToken.balanceOf(address(taxedZap)), 0);
        assertEq(taxedToken.balanceOf(address(0xdead)), 0, "fee side effect rolled back");
        assertFalse(_permitNonceUsed(owner, permit.nonce));
    }

    function test_erc1271OwnerSignsBothIntentAndPermitWitness() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(owner);
        Policy memory policy = _defaultPolicy();
        policy.owner = address(wallet);
        OpenZap walletZap = OpenZap(payable(factory.createZap(policy, bytes32("permit-1271"))));
        tokenIn.mint(address(wallet), AMOUNT_IN);
        vm.prank(address(wallet));
        tokenIn.approve(PERMIT2, type(uint256).max);

        OpenZapIntent memory intent = _intentFor(walletZap);
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 53);
        walletZap.executeWithPermit2(
            intent,
            permit,
            _signIntent(OWNER_PK, intent),
            _signPermit(OWNER_PK, permit, address(walletZap), _witness(intent, address(walletZap)))
        );

        assertEq(tokenIn.balanceOf(address(wallet)), 0);
        assertEq(tokenOut.balanceOf(recipient), 99e18);
        assertTrue(_permitNonceUsed(address(wallet), permit.nonce));
    }

    function test_haltBlocksPermit2BeforeAuthorizationOrAssetMovement() public {
        OpenZapIntent memory intent = _defaultIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 54);
        vm.prank(owner);
        zap.haltPolicy();

        vm.expectRevert(OpenZap.PolicyExecutionHalted.selector);
        zap.executeWithPermit2(intent, permit, "", "");
        assertEq(tokenIn.balanceOf(owner), AMOUNT_IN);
        assertFalse(zap.nonceUsed(intent.nonce));
        assertFalse(_permitNonceUsed(owner, permit.nonce));
    }

    function test_missingPermit2AndSameAssetSettlementFailClosed() public {
        OpenZapIntent memory intent = _defaultIntent();
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = _permit(intent, 55);

        vm.etch(PERMIT2, hex"");
        vm.expectRevert(OpenZap.Permit2Unavailable.selector);
        zap.executeWithPermit2(intent, permit, "", "");

        MockPermit2SignatureTransfer permit2Runtime = new MockPermit2SignatureTransfer();
        vm.etch(PERMIT2, address(permit2Runtime).code);
        intent.outAsset = address(tokenIn);
        vm.expectRevert(OpenZap.Permit2OutputAssetConflict.selector);
        zap.executeWithPermit2(intent, permit, "", "");
    }

    function _intentFor(OpenZap target) internal view returns (OpenZapIntent memory intent) {
        intent = _defaultIntent();
        intent.zap = address(target);
        intent.policyHash = target.policyHash();
    }

    function _permit(OpenZapIntent memory intent, uint256 permitNonce)
        internal
        view
        returns (IPermit2SignatureTransfer.PermitTransferFrom memory permit)
    {
        OpenZap target = OpenZap(payable(intent.zap));
        Step memory fundingStep = target.step(0);
        permit = IPermit2SignatureTransfer.PermitTransferFrom({
            permitted: IPermit2SignatureTransfer.TokenPermissions({
                token: fundingStep.tokenIn, amount: fundingStep.amountIn
            }),
            nonce: permitNonce,
            deadline: intent.deadline
        });
    }

    function _witness(OpenZapIntent memory intent, address verifyingZap) internal view returns (bytes32) {
        return keccak256(abi.encode(OPENZAP_WITNESS_TYPEHASH, _digest(intent, verifyingZap)));
    }

    function _signPermit(
        uint256 privateKey,
        IPermit2SignatureTransfer.PermitTransferFrom memory permit,
        address spender,
        bytes32 witness
    ) internal view returns (bytes memory) {
        bytes32 tokenPermissionsHash = keccak256(
            abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount)
        );
        bytes32 permitTypehash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                WITNESS_TYPE_STRING
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(permitTypehash, tokenPermissionsHash, spender, permit.nonce, permit.deadline, witness)
        );
        bytes32 domain = keccak256(abi.encode(PERMIT2_DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, PERMIT2));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(privateKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _permitNonceUsed(address permitOwner, uint256 permitNonce) internal view returns (bool) {
        uint256 bitmap = permit2.nonceBitmap(permitOwner, permitNonce >> 8);
        return bitmap & (uint256(1) << uint8(permitNonce)) != 0;
    }
}
