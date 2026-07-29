// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Script, console2 } from "forge-std/Script.sol";
import { ZapPadLaunchpad } from "../src/ZapPadLaunchpad.sol";

/// @notice Recovery-only cleanup after an interrupted stateful canary broadcast.
contract CleanupCanaryAllowances is Script {
    using SafeERC20 for IERC20;

    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    error WrongChain();
    error InvalidStack();
    error BroadcastSenderMismatch();
    error InvalidCanaryToken(address token);
    error AllowanceNotCleared(address token, address spender, uint256 allowance);

    function run() external {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain();

        ZapPadLaunchpad launchpad = ZapPadLaunchpad(vm.envAddress("ZAPPAD_LAUNCHPAD"));
        address creator = vm.envAddress("CANARY_CREATOR");
        address wethCanaryToken = vm.envOr("WETH_CANARY_TOKEN", address(0));
        address usdgCanaryToken = vm.envOr("USDG_CANARY_TOKEN", address(0));
        if (
            address(launchpad).code.length == 0 || launchpad.ROBINHOOD_CHAIN_ID() != ROBINHOOD_CHAIN_ID
                || launchpad.weth() != WETH || launchpad.usdg() != USDG
        ) revert InvalidStack();

        _validateCanaryToken(launchpad, creator, wethCanaryToken, WETH);
        _validateCanaryToken(launchpad, creator, usdgCanaryToken, USDG);
        address router = address(launchpad.swapRouter());

        vm.startBroadcast();
        (, address activeSender,) = vm.readCallers();
        if (activeSender != creator) revert BroadcastSenderMismatch();
        IERC20(WETH).forceApprove(router, 0);
        IERC20(USDG).forceApprove(router, 0);
        IERC20(USDG).forceApprove(address(launchpad), 0);
        if (wethCanaryToken != address(0)) IERC20(wethCanaryToken).forceApprove(router, 0);
        if (usdgCanaryToken != address(0)) IERC20(usdgCanaryToken).forceApprove(router, 0);
        vm.stopBroadcast();

        _requireZero(IERC20(WETH), creator, router);
        _requireZero(IERC20(USDG), creator, router);
        _requireZero(IERC20(USDG), creator, address(launchpad));
        if (wethCanaryToken != address(0)) {
            _requireZero(IERC20(wethCanaryToken), creator, router);
        }
        if (usdgCanaryToken != address(0)) {
            _requireZero(IERC20(usdgCanaryToken), creator, router);
        }
        console2.log("Canary allowances cleared for", creator);
    }

    function _validateCanaryToken(
        ZapPadLaunchpad launchpad,
        address creator,
        address token,
        address expectedPair
    ) private view {
        if (token == address(0)) return;
        (bool exists, address recordedCreator,,,, address pairedAsset,,) = launchpad.launches(token);
        if (token.code.length == 0 || !exists || recordedCreator != creator || pairedAsset != expectedPair) {
            revert InvalidCanaryToken(token);
        }
    }

    function _requireZero(IERC20 token, address owner, address spender) private view {
        uint256 remaining = token.allowance(owner, spender);
        if (remaining != 0) {
            revert AllowanceNotCleared(address(token), spender, remaining);
        }
    }
}
