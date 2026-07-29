// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {IPermit2SignatureTransfer} from "../src/interfaces/IPermit2SignatureTransfer.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";

/// @notice Opt-in, fixed-block integration against Robinhood Chain's real canonical Permit2
///         SignatureTransfer runtime. Tokens and adapter stay local so this test isolates the
///         owner-pull authorization boundary rather than live-pool liquidity.
contract RobinhoodPermit2OwnerPullForkTest is Test {
    uint256 internal constant FORK_BLOCK = 16_728_000;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant AMOUNT_IN = 100e18;

    bytes32 internal constant PERMIT2_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant OPENZAP_WITNESS_TYPEHASH = keccak256("OpenZapIntentWitness(bytes32 intentDigest)");
    string internal constant WITNESS_TYPE_STRING =
        "OpenZapIntentWitness witness)OpenZapIntentWitness(bytes32 intentDigest)TokenPermissions(address token,uint256 amount)";

    function test_realRobinhoodPermit2WitnessPull() public {
        if (!vm.envOr("RUN_ROBINHOOD_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(
            vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")), FORK_BLOCK
        );
        assertEq(block.chainid, 4663, "wrong fork");
        assertGt(PERMIT2.code.length, 0, "canonical Permit2 missing");

        address owner = vm.addr(OWNER_PK);
        address recipient = makeAddr("permit2-recipient");

        AdapterRegistry registry = new AdapterRegistry(address(this));
        TokenAllowlist allowlist = new TokenAllowlist(address(this));
        OpenZapFactory factory = new OpenZapFactory(registry, allowlist);
        MockERC20 tokenIn = new MockERC20("Input", "IN", 18);
        MockERC20 tokenOut = new MockERC20("Output", "OUT", 18);
        MockSwapAdapter adapter = new MockSwapAdapter();

        registry.setAdapter(address(adapter), true);
        allowlist.setToken(address(tokenIn), true);
        allowlist.setToken(address(tokenOut), true);
        tokenOut.mint(address(adapter), AMOUNT_IN);

        address[] memory tracked = new address[](2);
        tracked[0] = address(tokenIn);
        tracked[1] = address(tokenOut);
        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(adapter),
            tokenIn: address(tokenIn),
            spender: address(adapter),
            amountIn: AMOUNT_IN,
            data: abi.encode(address(tokenOut), uint256(1e18))
        });
        Policy memory policy = Policy({
            owner: owner,
            recipient: recipient,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
        OpenZap zap = OpenZap(payable(factory.createZap(policy, bytes32("real-permit2"))));

        tokenIn.mint(owner, AMOUNT_IN);
        vm.prank(owner);
        tokenIn.approve(PERMIT2, type(uint256).max);

        OpenZapIntent memory intent = OpenZapIntent({
            zap: address(zap),
            chainId: block.chainid,
            nonce: 7,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 10 minutes),
            recipient: recipient,
            relayer: address(0),
            maxRelayerFee: 0,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: address(tokenOut),
            minOut: AMOUNT_IN
        });
        IPermit2SignatureTransfer.PermitTransferFrom memory permit = IPermit2SignatureTransfer.PermitTransferFrom({
            permitted: IPermit2SignatureTransfer.TokenPermissions({token: address(tokenIn), amount: AMOUNT_IN}),
            nonce: 0xA11CE,
            deadline: intent.deadline
        });

        (uint8 intentV, bytes32 intentR, bytes32 intentS) = vm.sign(OWNER_PK, zap.hashIntent(intent));
        bytes memory intentSig = abi.encodePacked(intentR, intentS, intentV);
        bytes32 witness = keccak256(abi.encode(OPENZAP_WITNESS_TYPEHASH, zap.hashIntent(intent)));
        bytes memory permitSig = _signPermit(permit, address(zap), witness);

        zap.executeWithPermit2(intent, permit, intentSig, permitSig);

        assertEq(tokenIn.balanceOf(owner), 0, "owner input not pulled");
        assertEq(tokenIn.balanceOf(address(zap)), 0, "capsule retained pulled input");
        assertEq(tokenOut.balanceOf(recipient), AMOUNT_IN, "recipient output");
        assertEq(tokenIn.allowance(owner, address(this)), 0, "submitter gained allowance");
        assertEq(tokenIn.allowance(address(zap), address(adapter)), 0, "adapter allowance retained");
        assertTrue(zap.nonceUsed(intent.nonce), "OpenZap nonce not consumed");
    }

    function _signPermit(IPermit2SignatureTransfer.PermitTransferFrom memory permit, address spender, bytes32 witness)
        internal
        view
        returns (bytes memory)
    {
        bytes32 tokenPermissionsHash =
            keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount));
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
