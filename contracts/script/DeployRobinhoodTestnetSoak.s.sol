// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {Step, Policy} from "../src/libraries/OpenZapTypes.sol";
import {OpenZapV3} from "../src/v3/OpenZapV3.sol";
import {OpenZapFactoryV3} from "../src/v3/OpenZapFactoryV3.sol";
import {ZapLotteryPot} from "../src/v3/ZapLotteryPot.sol";
import {
    RobinhoodTestnetSoakToken,
    RobinhoodTestnetFixedRateAdapter,
    RobinhoodTestnetSoakPriceSource
} from "../src/testnet/RobinhoodTestnetSoakSupport.sol";

/// @title DeployRobinhoodTestnetSoak
/// @notice TESTNET ONLY / NON-PRODUCTION bootstrap for a disposable executor soak on Robinhood
///         testnet (chain 46630). Every run creates an isolated stack:
///           - fresh adapter, token, and price-source registries;
///           - two fixed-supply tokens whose names say TEST ONLY;
///           - one fixed-route, fixed-rate adapter funded only with the test output token;
///           - one operator-controlled synthetic price source for trigger/outage drills;
///           - one v3 recurring/trigger factory + implementation + lottery pot; and
///           - one clone funded for exactly 24 fixed-size executions.
///
/// @dev This path never reads, reuses, or mutates a Robinhood mainnet address. The script and every
///      test support contract refuse all chain IDs except 46630. Its output is an unaudited,
///      disposable test fixture and MUST NOT be published as a production deployment.
///
///      Rehearse first, without `--broadcast`:
///
///        forge script script/DeployRobinhoodTestnetSoak.s.sol:DeployRobinhoodTestnetSoak \
///          --sig 'run(address)' <testnet-only-deployer> \
///          --rpc-url <robinhood-testnet-rpc> --sender <testnet-only-deployer>
///
///      The explicit signature and positional deployer are mandatory for operator commands because
///      this script overloads `run()` and `run(address)`. Do not rely on Forge to choose an
///      entrypoint or infer the deployment owner.
///
///      A future operator may add `--broadcast` only after completing the dated soak runbook. This
///      source contains no key material and intentionally has no mainnet fallback.
contract DeployRobinhoodTestnetSoak is Script {
    string public constant ARTIFACT_CLASSIFICATION = "TESTNET ONLY / NON-PRODUCTION / DISPOSABLE";
    uint256 public constant ROBINHOOD_TESTNET_CHAIN_ID = 46630;
    string public constant EXPECTED_VERSION = "3.0.0-candidate";

    string public constant INPUT_NAME = "Robinhood Testnet Soak Input (TEST ONLY)";
    string public constant INPUT_SYMBOL = "rtSOAK-IN";
    string public constant OUTPUT_NAME = "Robinhood Testnet Soak ZAPS (TEST ONLY)";
    string public constant OUTPUT_SYMBOL = "rtZAPS";

    uint256 public constant INITIAL_PRICE_X96 = 1 << 96;
    uint256 public constant FIXED_RATE_WAD = 1e18;
    uint256 public constant SOAK_STEP_AMOUNT = 1 ether;
    uint256 public constant SOAK_FUNDED_RUNS = 24;
    uint256 public constant SOAK_INPUT_SUPPLY = SOAK_STEP_AMOUNT * SOAK_FUNDED_RUNS;
    uint256 public constant ADAPTER_OUTPUT_LIQUIDITY = SOAK_INPUT_SUPPLY * 2;
    bytes32 public constant SOAK_SALT = keccak256("OPENZAPS_ROBINHOOD_TESTNET_SOAK_V1");

    error WrongChain(uint256 actualChainId);
    error ZeroDeployer();
    error DeployerSenderMismatch(address deployer, address sender);
    error TestTokenTransferFailed(address token, address recipient, uint256 amount);
    error DeploymentAssertionFailed(bytes32 check);

    struct Deployed {
        AdapterRegistry adapters;
        TokenAllowlist tokens;
        AdapterRegistry priceSources;
        RobinhoodTestnetSoakToken inputToken;
        RobinhoodTestnetSoakToken outputToken;
        RobinhoodTestnetFixedRateAdapter adapter;
        RobinhoodTestnetSoakPriceSource priceSource;
        ZapLotteryPot lotteryPot;
        OpenZapFactoryV3 factory;
        address implementation;
        address soakZap;
        bytes32 policyHash;
    }

    function run() external returns (Deployed memory d) {
        return _run(msg.sender);
    }

    /// @notice Explicit-sender entrypoint used by deterministic deployment tests and required for
    ///         operator commands as `--sig 'run(address)' <deployer>`. It carries the identical
    ///         chain guard and assertions as `run()`; `deployer` must be the testnet signer
    ///         configured in Forge.
    function run(address deployer) external returns (Deployed memory d) {
        if (deployer != msg.sender) revert DeployerSenderMismatch(deployer, msg.sender);
        return _run(deployer);
    }

    function _run(address deployer) internal returns (Deployed memory d) {
        if (block.chainid != ROBINHOOD_TESTNET_CHAIN_ID) revert WrongChain(block.chainid);
        if (deployer == address(0)) revert ZeroDeployer();

        vm.startBroadcast(deployer);

        d.adapters = new AdapterRegistry(deployer);
        d.tokens = new TokenAllowlist(deployer);
        d.priceSources = new AdapterRegistry(deployer);

        d.inputToken = new RobinhoodTestnetSoakToken(INPUT_NAME, INPUT_SYMBOL, 18, deployer, SOAK_INPUT_SUPPLY);
        d.outputToken =
            new RobinhoodTestnetSoakToken(OUTPUT_NAME, OUTPUT_SYMBOL, 18, deployer, ADAPTER_OUTPUT_LIQUIDITY);

        d.adapter = new RobinhoodTestnetFixedRateAdapter(address(d.inputToken), address(d.outputToken), FIXED_RATE_WAD);
        d.priceSource = new RobinhoodTestnetSoakPriceSource(deployer, INITIAL_PRICE_X96);

        d.adapters.setAdapter(address(d.adapter), true);
        d.tokens.setToken(address(d.inputToken), true);
        d.tokens.setToken(address(d.outputToken), true);
        d.priceSources.setAdapter(address(d.priceSource), true);

        d.lotteryPot = new ZapLotteryPot(deployer, address(d.outputToken), address(d.adapter));
        d.factory = new OpenZapFactoryV3(d.adapters, d.tokens, d.priceSources, d.lotteryPot);
        d.lotteryPot.setFactory(address(d.factory));

        Policy memory soakPolicy = _soakPolicy(deployer, d);
        d.soakZap = d.factory.createZap(soakPolicy, SOAK_SALT);

        if (!d.inputToken.transfer(d.soakZap, SOAK_INPUT_SUPPLY)) {
            revert TestTokenTransferFailed(address(d.inputToken), d.soakZap, SOAK_INPUT_SUPPLY);
        }
        if (!d.outputToken.transfer(address(d.adapter), ADAPTER_OUTPUT_LIQUIDITY)) {
            revert TestTokenTransferFailed(address(d.outputToken), address(d.adapter), ADAPTER_OUTPUT_LIQUIDITY);
        }

        vm.stopBroadcast();

        d.implementation = d.factory.implementation();
        d.policyHash = OpenZapV3(payable(d.soakZap)).policyHash();

        _assertDeployment(deployer, d, soakPolicy);
        _report(deployer, d);
    }

    function _soakPolicy(address deployer, Deployed memory d) internal pure returns (Policy memory p) {
        address[] memory trackedAssets = new address[](2);
        trackedAssets[0] = address(d.inputToken);
        trackedAssets[1] = address(d.outputToken);

        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(d.adapter),
            tokenIn: address(d.inputToken),
            spender: address(d.adapter),
            amountIn: SOAK_STEP_AMOUNT,
            data: ""
        });

        p = Policy({
            owner: deployer,
            recipient: deployer,
            maxRelayerFeeCap: 0,
            optimization: true,
            trackedAssets: trackedAssets,
            steps: steps
        });
    }

    function _assertDeployment(address deployer, Deployed memory d, Policy memory p) internal view {
        _check(block.chainid == ROBINHOOD_TESTNET_CHAIN_ID, "CHAIN_ID");

        _check(address(d.adapters).code.length != 0, "ADAPTER_REGISTRY_CODE");
        _check(address(d.tokens).code.length != 0, "TOKEN_REGISTRY_CODE");
        _check(address(d.priceSources).code.length != 0, "PRICE_REGISTRY_CODE");
        _check(address(d.inputToken).code.length != 0, "INPUT_TOKEN_CODE");
        _check(address(d.outputToken).code.length != 0, "OUTPUT_TOKEN_CODE");
        _check(address(d.adapter).code.length != 0, "ADAPTER_CODE");
        _check(address(d.priceSource).code.length != 0, "PRICE_SOURCE_CODE");
        _check(address(d.lotteryPot).code.length != 0, "POT_CODE");
        _check(address(d.factory).code.length != 0, "FACTORY_CODE");
        _check(d.implementation.code.length != 0, "IMPLEMENTATION_CODE");
        _check(d.soakZap.code.length != 0, "SOAK_ZAP_CODE");

        _assertGovernance(deployer, d);
        _assertTestAssets(deployer, d);
        _assertLineage(deployer, d, p);
    }

    function _assertGovernance(address deployer, Deployed memory d) internal view {
        _check(d.adapters.owner() == deployer, "ADAPTER_REGISTRY_OWNER");
        _check(d.adapters.pendingOwner() == address(0), "ADAPTER_REGISTRY_PENDING");
        _check(d.tokens.owner() == deployer, "TOKEN_REGISTRY_OWNER");
        _check(d.tokens.pendingOwner() == address(0), "TOKEN_REGISTRY_PENDING");
        _check(d.priceSources.owner() == deployer, "PRICE_REGISTRY_OWNER");
        _check(d.priceSources.pendingOwner() == address(0), "PRICE_REGISTRY_PENDING");
        _check(d.lotteryPot.owner() == deployer, "POT_OWNER");
        _check(d.lotteryPot.pendingOwner() == address(0), "POT_PENDING");
        _check(d.priceSource.owner() == deployer, "PRICE_SOURCE_OWNER");
    }

    function _assertTestAssets(address deployer, Deployed memory d) internal view {
        _check(keccak256(bytes(d.inputToken.name())) == keccak256(bytes(INPUT_NAME)), "INPUT_TOKEN_NAME");
        _check(keccak256(bytes(d.inputToken.symbol())) == keccak256(bytes(INPUT_SYMBOL)), "INPUT_TOKEN_SYMBOL");
        _check(keccak256(bytes(d.outputToken.name())) == keccak256(bytes(OUTPUT_NAME)), "OUTPUT_TOKEN_NAME");
        _check(keccak256(bytes(d.outputToken.symbol())) == keccak256(bytes(OUTPUT_SYMBOL)), "OUTPUT_TOKEN_SYMBOL");
        _check(d.inputToken.decimals() == 18, "INPUT_TOKEN_DECIMALS");
        _check(d.outputToken.decimals() == 18, "OUTPUT_TOKEN_DECIMALS");
        _check(d.inputToken.initialHolder() == deployer, "INPUT_INITIAL_HOLDER");
        _check(d.outputToken.initialHolder() == deployer, "OUTPUT_INITIAL_HOLDER");
        _check(d.inputToken.totalSupply() == SOAK_INPUT_SUPPLY, "INPUT_TOTAL_SUPPLY");
        _check(d.outputToken.totalSupply() == ADAPTER_OUTPUT_LIQUIDITY, "OUTPUT_TOTAL_SUPPLY");
        _check(d.inputToken.balanceOf(d.soakZap) == SOAK_INPUT_SUPPLY, "SOAK_INPUT_FUNDING");
        _check(d.inputToken.balanceOf(deployer) == 0, "DEPLOYER_INPUT_BALANCE");
        _check(d.outputToken.balanceOf(address(d.adapter)) == ADAPTER_OUTPUT_LIQUIDITY, "ADAPTER_OUTPUT");
        _check(d.outputToken.balanceOf(deployer) == 0, "DEPLOYER_OUTPUT_BALANCE");
        _check(d.inputToken.balanceOf(address(d.adapter)) == 0, "ADAPTER_INPUT_START");

        _check(d.adapter.INPUT_TOKEN() == address(d.inputToken), "ADAPTER_INPUT_PIN");
        _check(d.adapter.OUTPUT_TOKEN() == address(d.outputToken), "ADAPTER_OUTPUT_PIN");
        _check(d.adapter.RATE_WAD() == FIXED_RATE_WAD, "ADAPTER_RATE_PIN");
        _check(d.priceSource.priceX96() == INITIAL_PRICE_X96, "PRICE_SOURCE_VALUE");
        _check(d.adapters.isAllowed(address(d.adapter)), "ADAPTER_ALLOWLIST");
        _check(d.tokens.isAllowed(address(d.inputToken)), "INPUT_ALLOWLIST");
        _check(d.tokens.isAllowed(address(d.outputToken)), "OUTPUT_ALLOWLIST");
        _check(d.priceSources.isAllowed(address(d.priceSource)), "PRICE_SOURCE_ALLOWLIST");
    }

    function _assertLineage(address deployer, Deployed memory d, Policy memory p) internal view {
        _check(keccak256(bytes(d.factory.VERSION())) == keccak256(bytes(EXPECTED_VERSION)), "FACTORY_VERSION");
        _check(address(d.factory.adapters()) == address(d.adapters), "FACTORY_ADAPTERS_PIN");
        _check(address(d.factory.tokens()) == address(d.tokens), "FACTORY_TOKENS_PIN");
        _check(address(d.factory.priceSources()) == address(d.priceSources), "FACTORY_PRICE_SOURCES_PIN");
        _check(address(d.factory.lotteryPot()) == address(d.lotteryPot), "FACTORY_POT_PIN");
        _check(d.factory.implCodeHash() == d.implementation.codehash, "IMPLEMENTATION_HASH");

        _check(d.lotteryPot.ZAPS() == address(d.outputToken), "POT_TOKEN_PIN");
        _check(d.lotteryPot.BUY_ADAPTER() == address(d.adapter), "POT_ADAPTER_PIN");
        _check(d.lotteryPot.factory() == address(d.factory), "POT_FACTORY_PIN");
        _check(d.lotteryPot.isZap(d.soakZap), "POT_ZAP_REGISTRATION");

        OpenZapV3 implementation = OpenZapV3(payable(d.implementation));
        _check(implementation.FACTORY() == address(d.factory), "IMPLEMENTATION_FACTORY_PIN");
        _check(address(implementation.ADAPTERS()) == address(d.adapters), "IMPLEMENTATION_ADAPTERS_PIN");
        _check(address(implementation.TOKENS()) == address(d.tokens), "IMPLEMENTATION_TOKENS_PIN");
        _check(address(implementation.PRICE_SOURCES()) == address(d.priceSources), "IMPLEMENTATION_PRICE_PIN");
        _check(implementation.LOTTERY_POT() == address(d.lotteryPot), "IMPLEMENTATION_POT_PIN");
        _check(implementation.owner() == address(0), "IMPLEMENTATION_BRICKED");

        OpenZapV3 soakZap = OpenZapV3(payable(d.soakZap));
        _check(soakZap.FACTORY() == address(d.factory), "SOAK_ZAP_FACTORY_PIN");
        _check(address(soakZap.ADAPTERS()) == address(d.adapters), "SOAK_ZAP_ADAPTERS_PIN");
        _check(address(soakZap.TOKENS()) == address(d.tokens), "SOAK_ZAP_TOKENS_PIN");
        _check(address(soakZap.PRICE_SOURCES()) == address(d.priceSources), "SOAK_ZAP_PRICE_PIN");
        _check(soakZap.LOTTERY_POT() == address(d.lotteryPot), "SOAK_ZAP_POT_PIN");
        _check(soakZap.owner() == deployer, "SOAK_ZAP_OWNER");
        _check(soakZap.recipient() == deployer, "SOAK_ZAP_RECIPIENT");
        _check(soakZap.optimization(), "SOAK_ZAP_OPTIMIZATION");
        _check(!soakZap.policyHalted(), "SOAK_ZAP_ACTIVE");
        _check(soakZap.policyHash() == keccak256(abi.encode(p)), "SOAK_ZAP_POLICY_HASH");
        _check(d.policyHash == soakZap.policyHash(), "RETURNED_POLICY_HASH");
        _check(d.factory.predict(p, SOAK_SALT) == d.soakZap, "SOAK_ZAP_CREATE2");
        _check(soakZap.stepCount() == 1, "SOAK_ZAP_STEP_COUNT");

        Step memory deployedStep = soakZap.step(0);
        _check(deployedStep.adapter == address(d.adapter), "SOAK_STEP_ADAPTER");
        _check(deployedStep.tokenIn == address(d.inputToken), "SOAK_STEP_INPUT");
        _check(deployedStep.spender == address(d.adapter), "SOAK_STEP_SPENDER");
        _check(deployedStep.amountIn == SOAK_STEP_AMOUNT, "SOAK_STEP_AMOUNT");
        _check(deployedStep.data.length == 0, "SOAK_STEP_DATA");

        address[] memory tracked = soakZap.trackedAssets();
        _check(tracked.length == 2, "SOAK_TRACKED_COUNT");
        _check(tracked[0] == address(d.inputToken), "SOAK_TRACKED_INPUT");
        _check(tracked[1] == address(d.outputToken), "SOAK_TRACKED_OUTPUT");
    }

    function _check(bool ok, bytes32 check) private pure {
        if (!ok) revert DeploymentAssertionFailed(check);
    }

    function _report(address deployer, Deployed memory d) internal view {
        console2.log(ARTIFACT_CLASSIFICATION);
        console2.log("chainId              ", block.chainid);
        console2.log("testnet deployer     ", deployer);
        console2.log("adapter registry     ", address(d.adapters));
        console2.log("token allowlist      ", address(d.tokens));
        console2.log("price registry       ", address(d.priceSources));
        console2.log("TEST input token     ", address(d.inputToken));
        console2.log("TEST output token    ", address(d.outputToken));
        console2.log("fixed-rate adapter   ", address(d.adapter));
        console2.log("synthetic price      ", address(d.priceSource));
        console2.log("lottery pot          ", address(d.lotteryPot));
        console2.log("v3 factory           ", address(d.factory));
        console2.log("v3 implementation    ", d.implementation);
        console2.log("bounded soak zap     ", d.soakZap);
        console2.log("funded fixed runs    ", SOAK_FUNDED_RUNS);
        console2.logBytes32(d.policyHash);
    }
}
