// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Test} from "forge-std/Test.sol";

import {OpenZap} from "../src/OpenZap.sol";
import {OpenZapFactory} from "../src/OpenZapFactory.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {TokenAllowlist} from "../src/TokenAllowlist.sol";
import {Step, Policy, OpenZapIntent} from "../src/libraries/OpenZapTypes.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";

/// @dev Shared fixture: deploys governance + factory, creates a funded 1-step swap zap, and provides
///      an EIP-712 signing helper whose digest is computed independently of the contract.
abstract contract BaseTest is Test {
    // Independent copies of the contract's typehashes (a divergence would break signature tests).
    bytes32 internal constant INTENT_TYPEHASH = keccak256(
        "OpenZapIntent(address zap,uint256 chainId,uint256 nonce,uint64 validAfter,uint64 deadline,address recipient,address relayer,uint256 maxRelayerFee,uint256 maxGas,uint256 maxFeePerGas,bytes32 policyHash,address outAsset,uint256 minOut)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 internal constant OWNER_PK = 0xA11CE;
    address internal owner;
    address internal recipient = address(0xBEEF);
    address internal relayer = address(0xFEE);

    AdapterRegistry internal registry;
    TokenAllowlist internal allowlist;
    OpenZapFactory internal factory;
    MockERC20 internal tokenIn;
    MockERC20 internal tokenOut;
    MockSwapAdapter internal adapter;
    OpenZap internal zap;

    uint256 internal constant AMOUNT_IN = 100e18;
    uint256 internal constant FEE_CAP = 5e18;

    /// @dev Base mainnet, and the block every fork suite in this repo pins.
    uint256 internal constant BASE_CHAIN_ID = 8453;
    uint256 internal constant BASE_FORK_BLOCK = 48_900_000;

    function setUp() public virtual {
        // These suites are mock-only and need no chain state — but `forge test --fork-url <base>`
        // drops EVERY suite onto the ambient forked backend, where each address they touch
        // (`vm.prank`, `vm.deal`, a fresh EOA) becomes a remote account lookup. An ambient fork is
        // unpinned, Foundry writes no RPC disk cache for an unpinned fork, and so the same handful of
        // lookups is re-fetched on every run until a public endpoint answers HTTP 429 — which forge
        // reports as "failed to get account for 0x…", a fake failure with nothing to do with the code
        // under test. Re-pinning that ambient fork to the block the rest of the suite already caches
        // makes those lookups local and deterministic.
        //
        // Deliberately conditional: with no `--fork-url` the chain id is Foundry's local 31337, this
        // does nothing, and the unit suites stay entirely offline.
        if (block.chainid == BASE_CHAIN_ID) {
            vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")), BASE_FORK_BLOCK);
        }

        owner = vm.addr(OWNER_PK);

        registry = new AdapterRegistry(address(this));
        allowlist = new TokenAllowlist(address(this));
        factory = new OpenZapFactory(registry, allowlist);

        tokenIn = new MockERC20("In", "IN", 18);
        tokenOut = new MockERC20("Out", "OUT", 18);
        allowlist.setToken(address(tokenIn), true);
        allowlist.setToken(address(tokenOut), true);

        adapter = new MockSwapAdapter();
        registry.setAdapter(address(adapter), true);
        tokenOut.mint(address(adapter), 1_000_000e18); // adapter reserve

        zap = OpenZap(payable(factory.createZap(_defaultPolicy(), bytes32("zap-1"))));
        tokenIn.mint(address(zap), AMOUNT_IN);
    }

    // ---- policy / intent builders ----

    function _defaultPolicy() internal view returns (Policy memory p) {
        address[] memory tracked = new address[](2);
        tracked[0] = address(tokenIn);
        tracked[1] = address(tokenOut);

        Step[] memory steps = new Step[](1);
        steps[0] = Step({
            adapter: address(adapter),
            tokenIn: address(tokenIn),
            spender: address(adapter),
            amountIn: AMOUNT_IN,
            data: abi.encode(address(tokenOut), uint256(1e18)) // 1:1 rate
        });

        p = Policy({
            owner: owner,
            recipient: recipient,
            maxRelayerFeeCap: FEE_CAP,
            optimization: true,
            trackedAssets: tracked,
            steps: steps
        });
    }

    function _defaultIntent() internal view returns (OpenZapIntent memory it) {
        it = OpenZapIntent({
            zap: address(zap),
            chainId: block.chainid,
            nonce: 1,
            validAfter: 0,
            deadline: uint64(block.timestamp + 1 hours),
            recipient: recipient,
            relayer: relayer,
            maxRelayerFee: 1e18,
            maxGas: type(uint256).max,
            maxFeePerGas: type(uint256).max,
            policyHash: zap.policyHash(),
            outAsset: address(tokenOut),
            minOut: 99e18 // 100 in @1:1 minus 1 fee
        });
    }

    function _digest(OpenZapIntent memory it, address verifyingZap) internal view returns (bytes32) {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("OpenZap"), keccak256("1"), block.chainid, verifyingZap));
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

    function _signIntent(uint256 pk, OpenZapIntent memory it) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(it, it.zap));
        return abi.encodePacked(r, s, v);
    }
}
