// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ZapFeeVault } from "../../src/ZapFeeVault.sol";
import { ZapPadBootstrap } from "../../src/ZapPadBootstrap.sol";
import { ZapPadLaunchpad } from "../../src/ZapPadLaunchpad.sol";
import {
    INonfungiblePositionManager,
    ISwapRouter02,
    IUniswapV3Factory
} from "../../src/interfaces/IUniswapV3.sol";
import { ISafe, ISafeProxyFactory } from "../../src/interfaces/ISafe.sol";
import { SafeTreasuryDeployment } from "../../script/lib/SafeTreasuryDeployment.sol";
import { ZapPadCanaryValidation } from "../../script/lib/ZapPadCanaryValidation.sol";

/// @dev Fixed-block, no-broadcast rehearsal of the complete production canary lifecycle.
///      ROBINHOOD_RPC_URL="https://..." forge test \
///        --match-contract RobinhoodTwoCycleCanariesForkTest --no-storage-caching -vv
contract RobinhoodTwoCycleCanariesForkTest is Test {
    using SafeERC20 for IERC20;

    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    uint256 internal constant FORK_BLOCK = 21_955_368;

    address internal constant POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant USDG_POOL_WHALE = 0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a;

    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    bytes32 internal constant SAFE_PROXY_FACTORY_CODE_HASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    bytes32 internal constant SAFE_SINGLETON_CODE_HASH =
        0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    bytes32 internal constant SAFE_FALLBACK_HANDLER_CODE_HASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;

    uint256 internal constant OWNER_ONE_KEY = uint256(keccak256("ZapPad fork Safe owner one"));
    uint256 internal constant OWNER_TWO_KEY = uint256(keccak256("ZapPad fork Safe owner two"));
    uint256 internal constant OWNER_THREE_KEY = uint256(keccak256("ZapPad fork Safe owner three"));

    uint24 internal constant FEE_TIER = 3000;
    int24 internal constant WETH_FLOOR_TICK = -276_300;
    int24 internal constant USDG_FLOOR_TICK = -460_020;
    uint256 internal constant WETH_FIRST_BUY = 0.0001 ether;
    uint256 internal constant USDG_FIRST_BUY = 1_000_000;
    uint256 internal constant SHARE_TRANSFER = 10e18;

    struct CanaryConfig {
        string name;
        string symbol;
        string metadataURI;
        address pair;
        int24 floorTick;
        uint256 firstBuyPairIn;
        bytes32 saltSeed;
    }

    struct CanaryResult {
        address token;
        ZapFeeVault vault;
        uint256 positionId;
        ZapPadCanaryValidation.Distribution expected;
        uint256 safeTokenBalanceBefore;
        uint256 safePairBalanceBefore;
    }

    function test_liveCanonicalWethAndUsdgTwoCycleCanariesWithSafeClaims() public {
        if (!_selectFixedRobinhoodFork()) return;

        _assertCanonicalDependencies();
        address payable safeTreasury = payable(_deployFreshCanonicalSafe());
        ZapPadLaunchpad launchpad = ZapPadLaunchpad(
            new ZapPadBootstrap(safeTreasury, POSITION_MANAGER, SWAP_ROUTER, WETH, USDG).launchpad()
        );
        assertEq(address(launchpad.v3Factory()), V3_FACTORY, "launchpad V3 factory");
        assertEq(launchpad.protocolTreasury(), safeTreasury, "launchpad Safe treasury");

        vm.deal(address(this), 1 ether);
        vm.prank(USDG_POOL_WHALE);
        assertTrue(IERC20(USDG).transfer(address(this), 10_000_000), "fund canonical USDG");

        CanaryResult memory wethResult = _runTwoCycleCanary(
            launchpad,
            safeTreasury,
            CanaryConfig({
                name: "ZapPad WETH Canary",
                symbol: "ZPWC",
                metadataURI: "urn:zappad:canary:weth:v1",
                pair: WETH,
                floorTick: WETH_FLOOR_TICK,
                firstBuyPairIn: WETH_FIRST_BUY,
                saltSeed: keccak256("ZapPad WETH Canary v1")
            })
        );
        CanaryResult memory usdgResult = _runTwoCycleCanary(
            launchpad,
            safeTreasury,
            CanaryConfig({
                name: "ZapPad USDG Canary",
                symbol: "ZPUC",
                metadataURI: "urn:zappad:canary:usdg:v1",
                pair: USDG,
                floorTick: USDG_FLOOR_TICK,
                firstBuyPairIn: USDG_FIRST_BUY,
                saltSeed: keccak256("ZapPad USDG Canary v1")
            })
        );

        ISafe safe = ISafe(safeTreasury);
        assertEq(safe.nonce(), 0, "claims begin at fresh Safe nonce");
        _executeSafeClaim(safe, wethResult.vault);
        assertEq(safe.nonce(), 1, "WETH Safe claim nonce");
        _assertFinalized(launchpad, safeTreasury, wethResult);

        _executeSafeClaim(safe, usdgResult.vault);
        assertEq(safe.nonce(), 2, "USDG Safe claim nonce");
        _assertFinalized(launchpad, safeTreasury, usdgResult);
    }

    function _runTwoCycleCanary(ZapPadLaunchpad launchpad, address safeTreasury, CanaryConfig memory config)
        private
        returns (CanaryResult memory result)
    {
        (bytes32 salt, address predictedToken) = _mineSalt(launchpad, config);
        ZapPadLaunchpad.LaunchParams memory params = ZapPadLaunchpad.LaunchParams({
            name: config.name,
            symbol: config.symbol,
            metadataURI: config.metadataURI,
            salt: salt,
            floorTick: config.floorTick,
            pairedAsset: config.pair,
            feeTier: FEE_TIER,
            firstBuyPairIn: config.pair == WETH ? 0 : config.firstBuyPairIn,
            minFirstBuyTokensOut: 1
        });

        if (config.pair == USDG) {
            IERC20(USDG).forceApprove(address(launchpad), config.firstBuyPairIn);
        }
        (address tokenAddress, address vaultAddress) = config.pair == WETH
            ? launchpad.launch{ value: config.firstBuyPairIn }(params)
            : launchpad.launch(params);
        if (config.pair == USDG) IERC20(USDG).forceApprove(address(launchpad), 0);

        assertEq(tokenAddress, predictedToken, "CREATE2 token prediction");
        uint256 firstBuyTokenOut = IERC20(tokenAddress).balanceOf(address(this));
        assertGt(firstBuyTokenOut, 0, "first buy output");

        (
            bool exists,
            address creator,
            address pool,
            address recordedVault,
            uint256 positionId,
            address pair,
            uint24 feeTier,
            int24 floorTick
        ) = launchpad.launches(tokenAddress);
        assertTrue(exists, "launch recorded");
        assertEq(creator, address(this), "launch creator");
        assertEq(recordedVault, vaultAddress, "launch vault");
        assertEq(pair, config.pair, "launch pair");
        assertEq(feeTier, FEE_TIER, "launch fee");
        assertEq(floorTick, config.floorTick, "launch floor");
        assertEq(IUniswapV3Factory(V3_FACTORY).getPool(tokenAddress, config.pair, FEE_TIER), pool);
        assertEq(INonfungiblePositionManager(POSITION_MANAGER).ownerOf(positionId), vaultAddress);

        uint256 firstSellTokenIn = firstBuyTokenOut / 4;
        assertGt(firstSellTokenIn, 0, "first reverse amount");
        uint256 firstSellPairOut = _swap(tokenAddress, config.pair, firstSellTokenIn, address(this));
        assertGt(firstSellPairOut, 0, "first reverse output");

        ZapFeeVault vault = ZapFeeVault(vaultAddress);
        (uint256 firstHarvestToken, uint256 firstHarvestPair) = vault.harvest();
        assertGt(firstHarvestToken, 0, "first-cycle launch-token fees");
        assertGt(firstHarvestPair, 0, "first-cycle paired-asset fees");
        ZapPadCanaryValidation.Distribution memory initial = ZapPadCanaryValidation.assertInitialDistribution(
            vault, address(this), safeTreasury, firstHarvestToken, firstHarvestPair
        );

        assertTrue(vault.transfer(safeTreasury, SHARE_TRANSFER), "transfer fee shares to Safe");
        ZapPadCanaryValidation.assertTransferredShares(vault, address(this), safeTreasury, initial);

        uint256 secondBuyPairIn = firstSellPairOut / 2;
        assertGt(secondBuyPairIn, 0, "second buy amount");
        uint256 secondBuyTokenOut = _swap(config.pair, tokenAddress, secondBuyPairIn, address(this));
        assertGt(secondBuyTokenOut, 0, "second buy output");

        uint256 secondSellTokenIn = secondBuyTokenOut / 2;
        assertGt(secondSellTokenIn, 0, "second reverse amount");
        assertGt(
            _swap(tokenAddress, config.pair, secondSellTokenIn, address(this)), 0, "second reverse output"
        );

        (uint256 secondHarvestToken, uint256 secondHarvestPair) = vault.harvest();
        assertGt(secondHarvestToken, 0, "second-cycle launch-token fees");
        assertGt(secondHarvestPair, 0, "second-cycle paired-asset fees");
        ZapPadCanaryValidation.Distribution memory expected =
            ZapPadCanaryValidation.assertPostTransferDistribution(
                vault, address(this), safeTreasury, initial, secondHarvestToken, secondHarvestPair
            );
        assertGt(expected.creatorToken, 0, "creator token claim");
        assertGt(expected.creatorPair, 0, "creator pair claim");
        assertGt(expected.treasuryToken, 0, "Safe token claim");
        assertGt(expected.treasuryPair, 0, "Safe pair claim");

        (uint256 creatorTokenClaimed, uint256 creatorPairClaimed) = vault.claimAll(address(this));
        ZapPadCanaryValidation.assertCreatorClaimed(
            vault, address(this), creatorTokenClaimed, creatorPairClaimed, expected
        );
        ZapPadCanaryValidation.assertTreasuryClaimable(vault, safeTreasury, expected);
        ZapPadCanaryValidation.assertCustodyAndCleanup(
            launchpad, vault, address(this), tokenAddress, config.pair, positionId
        );

        result = CanaryResult({
            token: tokenAddress,
            vault: vault,
            positionId: positionId,
            expected: expected,
            safeTokenBalanceBefore: IERC20(tokenAddress).balanceOf(safeTreasury),
            safePairBalanceBefore: IERC20(config.pair).balanceOf(safeTreasury)
        });
    }

    function _assertFinalized(ZapPadLaunchpad launchpad, address safeTreasury, CanaryResult memory result)
        private
        view
    {
        ZapPadCanaryValidation.assertFinalized(
            launchpad,
            result.vault,
            address(this),
            safeTreasury,
            result.token,
            result.vault.pairedAsset(),
            result.positionId,
            result.expected,
            result.safeTokenBalanceBefore,
            result.safePairBalanceBefore
        );
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        private
        returns (uint256 amountOut)
    {
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(recipient);
        IERC20(tokenIn).forceApprove(SWAP_ROUTER, amountIn);
        amountOut = ISwapRouter02(SWAP_ROUTER)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: FEE_TIER,
                    recipient: recipient,
                    amountIn: amountIn,
                    amountOutMinimum: 1,
                    sqrtPriceLimitX96: 0
                })
            );
        IERC20(tokenIn).forceApprove(SWAP_ROUTER, 0);
        assertEq(IERC20(tokenOut).balanceOf(recipient) - balanceBefore, amountOut, "swap balance delta");
        assertEq(IERC20(tokenIn).allowance(address(this), SWAP_ROUTER), 0, "swap allowance");
    }

    function _deployFreshCanonicalSafe() private returns (address safeTreasury) {
        address[] memory owners = new address[](3);
        owners[0] = vm.addr(OWNER_ONE_KEY);
        owners[1] = vm.addr(OWNER_TWO_KEY);
        owners[2] = vm.addr(OWNER_THREE_KEY);
        bytes memory initializer = SafeTreasuryDeployment.initializer(owners, 2, SAFE_FALLBACK_HANDLER);
        uint256 saltNonce = uint256(keccak256("ZapPad two-cycle canonical fork Safe v1"));
        address predicted =
            SafeTreasuryDeployment.predict(SAFE_PROXY_FACTORY, SAFE_SINGLETON, initializer, saltNonce);
        SafeTreasuryDeployment.requireFresh(predicted);

        safeTreasury = ISafeProxyFactory(SAFE_PROXY_FACTORY)
            .createProxyWithNonce(SAFE_SINGLETON, initializer, saltNonce);
        SafeTreasuryDeployment.verify(
            safeTreasury,
            predicted,
            SAFE_SINGLETON,
            SAFE_FALLBACK_HANDLER,
            owners,
            2,
            ROBINHOOD_CHAIN_ID,
            true
        );
    }

    function _executeSafeClaim(ISafe safe, ZapFeeVault vault) private {
        bytes memory data = abi.encodeCall(ZapFeeVault.claimAll, (address(safe)));
        bytes32 transactionHash = safe.getTransactionHash(
            address(vault), 0, data, 0, 0, 0, 0, address(0), address(0), safe.nonce()
        );
        bytes memory signatures = _orderedSignatures(transactionHash, OWNER_ONE_KEY, OWNER_TWO_KEY);
        assertTrue(
            safe.execTransaction(
                address(vault), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures
            ),
            "2-of-3 Safe claim"
        );
    }

    function _orderedSignatures(bytes32 digest, uint256 firstKey, uint256 secondKey)
        private
        pure
        returns (bytes memory signatures)
    {
        (uint8 firstV, bytes32 firstR, bytes32 firstS) = vm.sign(firstKey, digest);
        (uint8 secondV, bytes32 secondR, bytes32 secondS) = vm.sign(secondKey, digest);
        bytes memory firstSignature = abi.encodePacked(firstR, firstS, firstV);
        bytes memory secondSignature = abi.encodePacked(secondR, secondS, secondV);
        signatures = vm.addr(firstKey) < vm.addr(secondKey)
            ? bytes.concat(firstSignature, secondSignature)
            : bytes.concat(secondSignature, firstSignature);
    }

    function _mineSalt(ZapPadLaunchpad launchpad, CanaryConfig memory config)
        private
        view
        returns (bytes32 salt, address predicted)
    {
        uint256 start = uint256(config.saltSeed);
        for (uint256 i; i < 100_000; ++i) {
            salt = bytes32(start + i);
            predicted = launchpad.predictTokenAddress(
                address(this), salt, config.name, config.symbol, config.metadataURI
            );
            if (predicted < config.pair && predicted.code.length == 0) return (salt, predicted);
        }
        revert("SALT_NOT_FOUND");
    }

    function _assertCanonicalDependencies() private view {
        assertEq(block.chainid, ROBINHOOD_CHAIN_ID, "Robinhood chain");
        assertEq(block.number, FORK_BLOCK, "pinned fork block");
        assertEq(POSITION_MANAGER.code.length > 0, true, "canonical NPM");
        assertEq(V3_FACTORY.code.length > 0, true, "canonical V3 factory");
        assertEq(SWAP_ROUTER.code.length > 0, true, "canonical router");
        assertEq(WETH.code.length > 0, true, "canonical WETH");
        assertEq(USDG.code.length > 0, true, "canonical USDG");
        assertEq(INonfungiblePositionManager(POSITION_MANAGER).factory(), V3_FACTORY, "NPM factory");
        assertEq(ISwapRouter02(SWAP_ROUTER).factory(), V3_FACTORY, "router factory");
        assertEq(IUniswapV3Factory(V3_FACTORY).feeAmountTickSpacing(FEE_TIER), 60, "tick spacing");
        assertEq(SAFE_PROXY_FACTORY.codehash, SAFE_PROXY_FACTORY_CODE_HASH, "Safe proxy factory");
        assertEq(SAFE_SINGLETON.codehash, SAFE_SINGLETON_CODE_HASH, "Safe singleton");
        assertEq(SAFE_FALLBACK_HANDLER.codehash, SAFE_FALLBACK_HANDLER_CODE_HASH, "Safe fallback handler");
    }

    function _selectFixedRobinhoodFork() private returns (bool selected) {
        string memory rpcUrl = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(rpcUrl, FORK_BLOCK);
        return true;
    }
}
