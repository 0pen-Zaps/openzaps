// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {OpenZapIntent, Policy, Step} from "../src/libraries/OpenZapTypes.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
}

contract SmokeRobinhood is Script {
    uint256 internal constant CHAIN_ID = 4663;
    uint256 internal constant AMOUNT_IN = 0.00005 ether;
    address internal constant FACTORY = 0xFC775017b25d2458623E2f3E735A4B750dD8b4E4;
    address internal constant ADAPTER = 0x04f62dA4b51a010eFa32aa81569169C47AEd602C;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant ZAPS = 0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07;

    error WrongChain(uint256 actual);
    error WrongSigner(address expected, address actual);
    error MissingCode(address target);
    error SmokeFailed();

    function run() external returns (address zapAddress, uint256 amountOut) {
        if (block.chainid != CHAIN_ID) revert WrongChain(block.chainid);
        _requireCode(FACTORY);
        _requireCode(ADAPTER);
        _requireCode(WETH);
        _requireCode(ZAPS);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address signer = vm.addr(deployerKey);
        address expected = 0xe17f5150A2954889988e63C49d41cc321c35B986;
        if (signer != expected) revert WrongSigner(expected, signer);

        Step[] memory steps = new Step[](1);
        steps[0] = Step({adapter: ADAPTER, spender: ADAPTER, tokenIn: WETH, amountIn: AMOUNT_IN, data: ""});
        address[] memory tracked = new address[](2);
        tracked[0] = WETH;
        tracked[1] = ZAPS;
        Policy memory policy = Policy({
            owner: signer,
            recipient: signer,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });

        bytes32 salt = keccak256(abi.encodePacked("OPENZAPS_ROBINHOOD_MAINNET_SMOKE_V1", signer, block.number));
        uint256 nonce = uint256(keccak256(abi.encodePacked(salt, "INTENT")));
        uint256 beforeOut = IERC20(ZAPS).balanceOf(signer);

        vm.startBroadcast(deployerKey);
        IWETH(WETH).deposit{value: AMOUNT_IN}();
        zapAddress = OpenZapFactory(FACTORY).createZap(policy, salt);
        if (!IERC20(WETH).transfer(zapAddress, AMOUNT_IN)) revert SmokeFailed();
        vm.stopBroadcast();

        OpenZapIntent memory intent = OpenZapIntent({
            zap: zapAddress,
            chainId: CHAIN_ID,
            nonce: nonce,
            validAfter: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 10 minutes),
            recipient: signer,
            relayer: address(0),
            maxRelayerFee: 0,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: OpenZap(payable(zapAddress)).policyHash(),
            outAsset: ZAPS,
            minOut: 1
        });
        bytes32 digest = OpenZap(payable(zapAddress)).hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(deployerKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.startBroadcast(deployerKey);
        OpenZap(payable(zapAddress)).execute(intent, signature);
        vm.stopBroadcast();

        amountOut = IERC20(ZAPS).balanceOf(signer) - beforeOut;
        if (
            amountOut == 0 || !OpenZap(payable(zapAddress)).nonceUsed(nonce) || IERC20(WETH).balanceOf(zapAddress) != 0
                || IERC20(WETH).allowance(zapAddress, ADAPTER) != 0
        ) revert SmokeFailed();

        console2.log("Smoke zap", zapAddress);
        console2.log("Output 0xZAPS", amountOut);
    }

    function _requireCode(address target) internal view {
        if (target.code.length == 0) revert MissingCode(target);
    }
}
