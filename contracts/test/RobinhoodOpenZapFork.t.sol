// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {RobinhoodV4SwapAdapter} from "../src/adapters/RobinhoodV4SwapAdapter.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";

interface IERC20ZapFork {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function deposit() external payable;
}

contract RobinhoodOpenZapForkTest is Test {
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;
    address internal constant HOOK = 0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc;

    function test_liveOpenZapPolicyRejectsSlippageThenExecutes() public {
        // Report a SKIP, never a PASS: an opt-in test that returns early looks identical to one
        // that ran, which is how a suite ends up green on coverage it never had.
        if (!vm.envOr("RUN_ROBINHOOD_FORK", false)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));

        AdapterRegistry registry = new AdapterRegistry(address(this));
        TokenAllowlist allowlist = new TokenAllowlist(address(this));
        OpenZapFactory factory = new OpenZapFactory(registry, allowlist);
        RobinhoodV4SwapAdapter adapter =
            new RobinhoodV4SwapAdapter(UNIVERSAL_ROUTER, PERMIT2, WETH, ZAPS, 0x800000, 200, HOOK);

        registry.setAdapter(address(adapter), true);
        allowlist.setToken(WETH, true);
        allowlist.setToken(ZAPS, true);

        uint256 ownerPk = 0xA11CE;
        address owner = vm.addr(ownerPk);
        address relayer = makeAddr("robinhood-relayer");
        uint256 amountIn = 0.0001 ether;

        Step[] memory steps = new Step[](1);
        steps[0] =
            Step({adapter: address(adapter), tokenIn: WETH, amountIn: amountIn, spender: address(adapter), data: ""});
        address[] memory trackedAssets = new address[](2);
        trackedAssets[0] = WETH;
        trackedAssets[1] = ZAPS;
        Policy memory policy = Policy({
            owner: owner,
            recipient: owner,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: trackedAssets,
            steps: steps
        });

        address zapAddress = factory.createZap(policy, keccak256("robinhood-live-fork"));
        OpenZap zap = OpenZap(payable(zapAddress));

        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        IERC20ZapFork(WETH).deposit{value: amountIn}();
        IERC20ZapFork(WETH).transfer(zapAddress, amountIn);
        vm.stopPrank();

        OpenZapIntent memory intent = _intent(zap, owner, type(uint256).max);
        bytes memory badSignature = _sign(zap, intent, ownerPk);
        vm.prank(relayer);
        vm.expectRevert(OpenZap.MinOutNotMet.selector);
        zap.execute(intent, badSignature);
        assertFalse(zap.nonceUsed(0));
        assertEq(IERC20ZapFork(WETH).balanceOf(zapAddress), amountIn);

        intent.minOut = 1;
        bytes memory signature = _sign(zap, intent, ownerPk);
        vm.prank(relayer);
        zap.execute(intent, signature);

        assertGt(IERC20ZapFork(ZAPS).balanceOf(owner), 0);
        assertEq(IERC20ZapFork(WETH).balanceOf(zapAddress), 0);
        assertEq(IERC20ZapFork(WETH).allowance(zapAddress, address(adapter)), 0);
        assertEq(IERC20ZapFork(WETH).balanceOf(address(adapter)), 0);
        assertEq(IERC20ZapFork(ZAPS).balanceOf(address(adapter)), 0);
        assertTrue(zap.nonceUsed(0));
    }

    function _intent(OpenZap zap, address recipient, uint256 minOut) internal view returns (OpenZapIntent memory) {
        return OpenZapIntent({
            zap: address(zap),
            chainId: block.chainid,
            nonce: 0,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 10 minutes),
            recipient: recipient,
            relayer: address(0),
            maxRelayerFee: 0,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: ZAPS,
            minOut: minOut
        });
    }

    function _sign(OpenZap zap, OpenZapIntent memory intent, uint256 privateKey) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, zap.hashIntent(intent));
        return abi.encodePacked(r, s, v);
    }
}
