// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "./Base.t.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Drives random sequences of execute / emergency-exit against one zap.
contract Handler is Test {
    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "OpenZapIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address recipient,address relayer,uint256 maxRelayerFee,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    OpenZap internal zap;
    MockERC20 internal tokenIn;
    MockERC20 internal tokenOut;
    address internal adapter;
    uint256 internal ownerPk;
    address internal owner;
    address internal recipient;
    address internal relayer;
    uint256 public nonce = 1;

    constructor(
        OpenZap zap_,
        MockERC20 tokenIn_,
        MockERC20 tokenOut_,
        address adapter_,
        uint256 ownerPk_,
        address recipient_,
        address relayer_
    ) {
        zap = zap_;
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        adapter = adapter_;
        ownerPk = ownerPk_;
        owner = vm.addr(ownerPk_);
        recipient = recipient_;
        relayer = relayer_;
    }

    function doExecute(uint256 feeSeed) external {
        tokenIn.mint(address(zap), 100e18); // ensure funds for the fixed-amount step
        OpenZapIntent memory it = OpenZapIntent({
            zap: address(zap),
            chainId: block.chainid,
            nonce: nonce++,
            validAfter: 0,
            deadline: type(uint64).max,
            recipient: recipient,
            relayer: relayer,
            maxRelayerFee: bound(feeSeed, 0, 5e18),
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: address(tokenOut),
            minOut: 0
        });
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("1"), block.chainid, address(zap))
        );
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        try zap.execute(it, abi.encodePacked(r, s, v)) {} catch {}
    }

    function doExit() external {
        address[] memory a = new address[](2);
        a[0] = address(tokenIn);
        a[1] = address(tokenOut);
        vm.prank(owner);
        try zap.emergencyExit(a) {} catch {}
    }
}

/// @notice Stateful invariants: no residual approval ever; implementation never owned.
contract OpenZapInvariants is BaseTest {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new Handler(zap, tokenIn, tokenOut, address(adapter), OWNER_PK, recipient, relayer);
        targetContract(address(handler));
    }

    /// @dev I-APPR-1: between transactions, the zap never holds a live approval to the adapter.
    function invariant_noResidualApproval() public view {
        assertEq(tokenIn.allowance(address(zap), address(adapter)), 0);
    }

    /// @dev I-ISO-1: the shared implementation is never initialized, so it never has an owner.
    function invariant_implementationNeverOwned() public view {
        assertEq(OpenZap(payable(factory.implementation())).owner(), address(0));
    }
}
