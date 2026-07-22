// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// =========================================================================================== //
//  AaveV3BorrowAdapter — DELIBERATELY NOT IMPLEMENTED                                         //
// =========================================================================================== //
//
// This file ships no adapter, and compiles to no deployable bytecode. That is the deliverable. A
// borrow leg cannot be expressed under `IAdapter` without either handing a shared adapter custody of
// somebody's collateral or leaving a zap owner unable to get their money back, so there is nothing
// here for an operator to allowlist by mistake.
//
// Every claim below is proved on a Base-mainnet fork in `test/AaveV3Adapters.fork.t.sol` against the
// live Aave v3 Pool at 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5 (POOL_REVISION 11). The named test
// is cited after each claim.
//
// ------------------------------------------------------------------------------------------- //
// 0. Aave is not the obstacle.
// ------------------------------------------------------------------------------------------- //
// An OpenZap clone is a perfectly ordinary Aave account. Acting as the clone, it supplies WETH,
// borrows USDC, receives the USDC, and carries the variable-debt token, with a health factor above
// one throughout.
//     -> test_borrow_aaveAllowsAZapAccountOnlyWhenTheZapItselfCallsThePool
// The obstacle is OpenZap's call surface, and it is worth being exact about where the wall is.
//
// ------------------------------------------------------------------------------------------- //
// 1. Aave requires credit delegation, and the zap can never grant it.
// ------------------------------------------------------------------------------------------- //
// `Pool.borrow(asset, amount, rateMode, referral, onBehalfOf)` credits the borrowed asset to
// `msg.sender` and opens the debt on `onBehalfOf`. For an adapter to borrow against the zap's
// collateral it must pass `onBehalfOf = zap`, and Aave then demands
// `borrowAllowance[zap][adapter] >= amount`. Without it the call reverts with
// `InsufficientBorrowAllowance(adapter, 0, amount)` — checked byte-for-byte on the fork.
//     -> test_borrow_adapterCannotBorrowOnBehalfOfTheZapWithoutDelegation
//
// That allowance is settable only by `IVariableDebtToken.approveDelegation(delegatee, amount)`
// (0xc04a8a10), called BY the debtor. Grant it as the zap and the very same adapter borrow
// succeeds — which is what makes this a call-surface problem and not an Aave problem.
//     -> test_borrow_succeedsOnlyAfterTheZapItselfGrantsDelegation
//
// OpenZap has no code path that emits that call. Its entire outbound surface is:
//     - `AdapterRegistry.isAllowed` / `TokenAllowlist.isAllowed`   (staticcall, governance reads)
//     - `IERC20.balanceOf`                                         (staticcall, accounting)
//     - `approve(address,uint256)` on a step's `tokenIn`, spender forced equal to the adapter
//     - `IAdapter.execute(address,uint256,bytes)` — one constant selector, allowlisted address
//     - `transfer(address,uint256)` in settlement and `emergencyExit`
//     - `owner.staticcall(isValidSignature)` (ERC-1271; a staticcall, so state-changing is out)
//     - `owner.call{value: bal}("")` in `emergencyExit` — empty calldata, fixed recipient
// There is no `delegatecall`, no arbitrary-target call, and no arbitrary calldata anywhere. The one
// approval primitive is `approve(address,uint256)`, a different function from `approveDelegation`,
// and pointing a step's `tokenIn` at the variable-debt token — the only address where a delegation
// could conceivably be smuggled through — dies inside Aave, whose debt tokens revert
// `OperationNotSupported()` for the entire ERC-20 approval surface. Proved both directly against
// the live debt token and end-to-end through a real zap clone.
//     -> test_borrow_openZapApprovalPrimitiveCannotReachCreditDelegation
//
// ------------------------------------------------------------------------------------------- //
// 2. The workaround — adapter as borrower — puts a stranger in custody of the collateral.
// ------------------------------------------------------------------------------------------- //
// The obvious escape is for the adapter to be the Aave account itself: supply
// `onBehalfOf = address(this)`, borrow as itself, forward the proceeds. Then the collateral, the
// collateral flag, the debt and the liquidation exposure all belong to one adapter that the
// `AdapterRegistry` shares across every zap on the chain. One user's borrow would be secured by
// another user's collateral, and one user's liquidation would eat it.
//
// It also breaks recovery outright. `OpenZap.emergencyExit` is the owner's single unconditional way
// out (invariant I-REC-1) and it moves only ERC-20 balances held by the zap. Collateral booked to
// the adapter is invisible to it: on the fork the owner's exit returns zero while the position sits
// on the adapter.
//     -> test_borrow_adapterHeldCollateralWouldEscapeEmergencyExit
//
// Deploying one adapter per zap would fix the commingling and none of the recovery problem, at the
// cost of a governance allowlist entry per user. Not a trade worth making.
//
// ------------------------------------------------------------------------------------------- //
// 3. Even with delegation, the debt itself is unrepresentable — and bricks the exit.
// ------------------------------------------------------------------------------------------- //
// Suppose, counterfactually, that the zap could delegate. Three things would still be wrong:
//
//   (a) `tokenIn` / `amountIn` have no meaning. A borrow consumes no token, but `initialize`
//       rejects `tokenIn == address(0)` and `amountIn == 0`, and `execute` grants the adapter a
//       real, nonzero allowance on a real allowlisted token before every step. A borrow step would
//       therefore have to invent a dummy input and hand the adapter spending authority it has no
//       accounting reason to hold. Authority with no counterpart in the settlement math is exactly
//       what this architecture exists to refuse.
//
//   (b) The proceeds go to the wrong address. Aave credits `msg.sender`, so the adapter receives
//       the borrowed asset and the zap receives the debt — a step that increases a balance and a
//       liability at once, while `OpenZap.execute` settles on the balance delta alone and has no
//       way to see, price, or bound the liability it just created.
//       -> test_borrow_succeedsOnlyAfterTheZapItselfGrantsDelegation
//
//   (c) Recovery stops working. Aave blocks collateral aToken transfers that would drop the
//       borrower's health factor below one, so once a zap carries debt, `emergencyExit` reverts on
//       the aToken leg — the same exit succeeds on an identical, debt-free zap. A borrow step would
//       leave owners locked behind a position no step can repay, since repayment needs a second
//       transaction and a token the zap has no way to source.
//       -> test_borrow_wouldBrickEmergencyExitOnTheZap
//
// ------------------------------------------------------------------------------------------- //
// 4. What would actually be needed.
// ------------------------------------------------------------------------------------------- //
// Not an adapter. A borrow leg needs core (v2) support: a way for a zap to make one narrow,
// policy-frozen non-adapter call (`approveDelegation` to a named delegatee for a bounded amount),
// settlement that accounts for liabilities as well as balances, and a recovery path that can repay
// debt before withdrawing collateral. Each of those is a change to `OpenZap`, not to this file.
//
// Until then the supply leg ships alone: see `AaveV3SupplyAdapter.sol`, which is clean precisely
// because supplying mints an ERC-20 aToken straight to the zap and creates no liability.
// =========================================================================================== //

/// @notice Intentionally empty. This declaration exists so the file yields a compilation unit; there
///         is no borrow adapter to implement it, and per the reasoning above there cannot be one under
///         the current `IAdapter` / `OpenZap.execute` contract. Do not implement this. If a v2 core
///         ever gains liability-aware settlement, delete this file and start from that design.
interface IAaveV3BorrowAdapterNotShipped {}
