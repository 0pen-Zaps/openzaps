// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {BaseTest} from "./Base.t.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";

/// @notice AUTH invariants: signature binding, replay, expiry, chain/zap/policy binding, gas cap.
contract AuthTest is BaseTest {
    function test_happyPath_executes() public {
        OpenZapIntent memory it = _defaultIntent();
        vm.prank(relayer);
        zap.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(recipient), 99e18, "recipient net");
        assertEq(tokenOut.balanceOf(relayer), 1e18, "relayer fee");
        assertEq(tokenIn.allowance(address(zap), address(adapter)), 0, "approval reset");
    }

    function test_contractDigestMatchesIndependentDigest() public view {
        OpenZapIntent memory it = _defaultIntent();
        assertEq(zap.hashIntent(it), _digest(it, address(zap)), "EIP-712 digest divergence");
    }

    function test_rejects_wrongPolicyHash() public {
        OpenZapIntent memory it = _defaultIntent();
        it.policyHash = bytes32(uint256(0xdead));
        vm.expectRevert(OpenZap.PolicyMismatch.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_replayNonce() public {
        OpenZapIntent memory it = _defaultIntent();
        bytes memory sig = _signIntent(OWNER_PK, it);
        zap.execute(it, sig);
        tokenIn.mint(address(zap), AMOUNT_IN); // refund so only the nonce can block it
        vm.expectRevert(OpenZap.NonceReplay.selector);
        zap.execute(it, sig);
    }

    function test_rejects_expiredDeadline() public {
        OpenZapIntent memory it = _defaultIntent();
        it.deadline = uint64(block.timestamp);
        bytes memory sig = _signIntent(OWNER_PK, it);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(OpenZap.Expired.selector);
        zap.execute(it, sig);
    }

    function test_rejects_notYetValid() public {
        OpenZapIntent memory it = _defaultIntent();
        it.validAfter = uint64(block.timestamp + 100);
        vm.expectRevert(OpenZap.NotYetValid.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_wrongSigner() public {
        OpenZapIntent memory it = _defaultIntent();
        vm.expectRevert(OpenZap.BadSignature.selector);
        zap.execute(it, _signIntent(0xB0B, it)); // not the owner key
    }

    function test_rejects_wrongChainId() public {
        OpenZapIntent memory it = _defaultIntent();
        it.chainId = 999;
        vm.expectRevert(OpenZap.WrongChain.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_wrongZap() public {
        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(0x1234);
        vm.expectRevert(OpenZap.WrongZap.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_gasPriceAboveCap() public {
        OpenZapIntent memory it = _defaultIntent();
        it.maxFeePerGas = 1;
        bytes memory sig = _signIntent(OWNER_PK, it);
        vm.txGasPrice(2);
        vm.expectRevert(OpenZap.GasPriceTooHigh.selector);
        zap.execute(it, sig);
    }

    function test_rejects_feeAboveCap() public {
        OpenZapIntent memory it = _defaultIntent();
        it.maxRelayerFee = FEE_CAP + 1;
        vm.expectRevert(OpenZap.FeeAboveCap.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_rejects_wrongRecipient() public {
        OpenZapIntent memory it = _defaultIntent();
        it.recipient = address(0x9999);
        vm.expectRevert(OpenZap.WrongRecipient.selector);
        zap.execute(it, _signIntent(OWNER_PK, it));
    }

    function test_erc1271_walletSigner() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(OWNER_PK));
        Policy memory p = _defaultPolicy();
        p.owner = address(wallet);
        OpenZap z2 = OpenZap(payable(factory.createZap(p, bytes32("zap-1271"))));
        tokenIn.mint(address(z2), AMOUNT_IN);

        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(z2);
        it.policyHash = z2.policyHash();
        vm.prank(relayer);
        z2.execute(it, _signIntent(OWNER_PK, it));
        assertEq(tokenOut.balanceOf(recipient), 99e18);
    }

    function test_erc1271_rejectsForeignSigner() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(vm.addr(OWNER_PK));
        Policy memory p = _defaultPolicy();
        p.owner = address(wallet);
        OpenZap z2 = OpenZap(payable(factory.createZap(p, bytes32("zap-1271b"))));
        tokenIn.mint(address(z2), AMOUNT_IN);

        OpenZapIntent memory it = _defaultIntent();
        it.zap = address(z2);
        it.policyHash = z2.policyHash();
        vm.expectRevert(OpenZap.BadSignature.selector);
        z2.execute(it, _signIntent(0xB0B, it));
    }
}
