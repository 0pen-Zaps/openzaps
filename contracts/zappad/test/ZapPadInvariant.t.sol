// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Test } from "forge-std/Test.sol";
import { ZapFeeVault } from "../src/ZapFeeVault.sol";
import { ZapToken } from "../src/ZapToken.sol";
import { ZapPadTestBase } from "./helpers/ZapPadTestBase.sol";
import { MockERC20, MockPositionManager } from "./mocks/MockUniswapV3.sol";

contract ZapFeeVaultHandler is Test {
    ZapToken public immutable token;
    ZapFeeVault public immutable vault;
    MockERC20 public immutable pair;
    MockPositionManager public immutable positionManager;
    uint256 public immutable positionId;
    address[4] private _actors;

    constructor(
        ZapToken token_,
        ZapFeeVault vault_,
        MockERC20 pair_,
        MockPositionManager positionManager_,
        address[4] memory actors_
    ) {
        token = token_;
        vault = vault_;
        pair = pair_;
        positionManager = positionManager_;
        positionId = vault_.positionId();
        _actors = actors_;
    }

    function harvestLaunch(uint96 rawAmount) external {
        (,,, uint256 alreadyOwed,) = positionManager.positions(positionId);
        uint256 managerBalance = token.balanceOf(address(positionManager));
        if (managerBalance <= alreadyOwed) return;
        uint256 available = managerBalance - alreadyOwed;
        uint256 cap = available < 1_000_000e18 ? available : 1_000_000e18;
        uint256 amount = uint256(rawAmount) % (cap + 1);
        if (amount == 0) return;
        positionManager.accrueFees(positionId, amount, 0);
        vault.harvest();
    }

    function harvestPair(uint96 rawAmount) external {
        uint256 amount = uint256(rawAmount) % (1_000_000e18 + 1);
        if (amount == 0) return;
        pair.mint(address(positionManager), amount);
        positionManager.accrueFees(positionId, 0, amount);
        vault.harvest();
    }

    function donateLaunch(uint96 rawAmount) external {
        uint256 managerBalance = token.balanceOf(address(positionManager));
        if (managerBalance == 0) return;
        uint256 cap = managerBalance < 1_000_000e18 ? managerBalance : 1_000_000e18;
        uint256 amount = uint256(rawAmount) % (cap + 1);
        if (amount == 0) return;
        vm.prank(address(positionManager));
        token.transfer(address(vault), amount);
        vault.sync();
    }

    function donatePair(uint96 rawAmount) external {
        uint256 amount = uint256(rawAmount) % (1_000_000e18 + 1);
        if (amount == 0) return;
        pair.mint(address(vault), amount);
        vault.sync();
    }

    function transferShares(uint8 fromSeed, uint8 toSeed, uint96 rawAmount) external {
        address from = _actors[fromSeed % _actors.length];
        address to = _actors[toSeed % _actors.length];
        if (from == to) return;
        uint256 balance = vault.balanceOf(from);
        if (balance == 0) return;
        uint256 amount = uint256(rawAmount) % (balance + 1);
        vm.prank(from);
        vault.transfer(to, amount);
    }

    function claim(uint8 actorSeed) external {
        address holder = _actors[actorSeed % _actors.length];
        vm.prank(holder);
        vault.claimAll(holder);
    }

    function sync() external {
        vault.sync();
    }

    function actor(uint256 index) external view returns (address) {
        return _actors[index];
    }
}

contract ZapPadInvariantTest is ZapPadTestBase {
    ZapToken internal token;
    ZapFeeVault internal vault;
    ZapFeeVaultHandler internal handler;
    uint256 internal positionId;

    function setUp() public override {
        super.setUp();
        (token, vault, positionId) = _launch(address(usdg), keccak256("invariant launch"));
        address[4] memory actors = [creator, treasury, alice, bob];
        handler = new ZapFeeVaultHandler(token, vault, usdg, positionManager, actors);

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.harvestLaunch.selector;
        selectors[1] = handler.harvestPair.selector;
        selectors[2] = handler.donateLaunch.selector;
        selectors[3] = handler.donatePair.selector;
        selectors[4] = handler.transferShares.selector;
        selectors[5] = handler.claim.selector;
        selectors[6] = handler.sync.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
    }

    function invariant_feeSharesRemainFixedAndFullyAccountedFor() public view {
        uint256 actorBalances;
        for (uint256 i; i < 4; ++i) {
            actorBalances += vault.balanceOf(handler.actor(i));
        }
        assertEq(vault.totalSupply(), vault.SHARE_SUPPLY());
        assertEq(actorBalances, vault.SHARE_SUPPLY());
    }

    function invariant_lpNftRemainsPermanentlyOwnedByVault() public view {
        assertEq(vault.positionId(), positionId);
        assertEq(positionManager.ownerOf(positionId), address(vault));
    }

    function invariant_launchTokenAccountingIsSolventAndConserved() public view {
        _assertAssetInvariant(address(token));
    }

    function invariant_pairAccountingIsSolventAndConserved() public view {
        _assertAssetInvariant(address(usdg));
    }

    function _assertAssetInvariant(address asset) private view {
        (, uint256 lastBalance, uint256 totalSynced, uint256 totalClaimed) = vault.assetState(asset);
        uint256 vaultBalance = IERC20(asset).balanceOf(address(vault));
        assertEq(vaultBalance, lastBalance);
        assertEq(totalSynced, totalClaimed + lastBalance);
        assertLe(totalClaimed, totalSynced);

        uint256 totalClaimable;
        for (uint256 i; i < 4; ++i) {
            totalClaimable += vault.claimable(handler.actor(i), asset);
        }
        assertLe(totalClaimable, vaultBalance);
    }
}
