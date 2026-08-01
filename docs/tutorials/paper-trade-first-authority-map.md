# Paper Trade First, Then Draw the Authority Map

**Publication:** DeFi Tutorials

**Status:** Prepared draft · owner review and approval required before editor handoff

**Suggested subtitle:** Test an agentic DeFi workflow without a wallet, then turn it into a human-reviewed OpenZaps authority map

**Suggested hero:** `docs/media/12-virtual-trading.jpg` (fresh production capture; do not reuse the retired ZapDraw image)

**Canonical CTA:** https://www.0xzaps.com/request-a-zap

> Disclosure: I work on OpenZaps. The contracts have not completed an external audit. Virtual Trading uses no wallet or real funds; a live onchain action is different, irreversible, and can lose money.

The safest time to discover that an automation idea is underspecified is before anyone connects a wallet.

That sounds obvious, but most agentic DeFi conversations start too far downstream. They jump from “watch this market” to “give the agent a signer,” then try to reduce the resulting authority with prompts, dashboards, and revocation procedures.

I prefer to start at zero authority.

First, paper trade the route. Then write down the exact action that succeeded or failed. Only after that should you draw an authority map: what may be triggered, what must be fixed before signing, and what the agent can never change.

OpenZaps now has two wallet-free surfaces for this sequence:

- [Virtual Trading](https://www.0xzaps.com/virtual-trading) for testing the market hypothesis with virtual funds.
- [Request a Zap](https://www.0xzaps.com/request-a-zap) for turning one workflow into a human-reviewed authority map.

Neither surface creates a Zap, signs a transaction, deposits funds, or authorizes an agent.

## Start with zero authority

Virtual Trading starts with 10,000 virtual USDG. It exposes the four pinned USDG routes used by the current OpenZaps catalog and obtains read-only route quotes against one canonical Robinhood Chain head. A quote is rejected if that head changes while the route is being evaluated.

The practice ledger, fills, positions, cost basis, NAV, and PnL remain in the browser. There is no wallet connection, approval, signature, transaction, reward, or ranked leaderboard.

That boundary is useful because it separates two different questions:

1. **Market hypothesis:** Would this exact-input route have produced the behavior I expected under the quoted conditions?
2. **Authority hypothesis:** If software may trigger a similar live action later, which fields must already be immutable?

Paper trading helps with the first question. It does not answer the second.

## Paper trade the route, not the story

A vague idea such as “buy dips” is not ready for automation. It leaves too many decisions open: which market, which asset, how much, how often, where the output settles, and when the strategy must stop.

Use Virtual Trading to make the idea concrete:

1. Choose one available USDG route.
2. Enter an exact virtual input amount.
3. Inspect the canonical-head quote and its source state.
4. Execute the virtual fill and record the observed output.
5. Repeat only enough times to understand the route, price movement, and position accounting.
6. Write down what would have invalidated the trade before it filled.

Do not treat a green virtual PnL number as proof of a strategy. The useful output is a more precise sentence.

For example:

> When a separately verified condition is met, submit one exact-input swap through one pinned route, within a fixed amount and output floor, and settle only to the owner.

That is still a hypothesis. It is simply a much better one.

## Translate the hypothesis into a policy boundary

Now draw the authority map. I use eight fields:

1. **Target:** the exact contract or adapter that may be called.
2. **Route and calldata shape:** the permitted function and argument structure.
3. **Input:** the exact asset and amount, or a tightly capped per-run amount.
4. **Output:** the expected asset and the minimum acceptable result.
5. **Recipient:** the one address allowed to receive settlement.
6. **Trigger:** the condition or due time a submitter may observe.
7. **Cadence and lifetime:** how often the action may run, how many runs exist, and when authority expires.
8. **Recovery:** how the owner stops, invalidates, withdraws, or replaces the policy.

Then add a ninth section called **Forbidden authority**.

For a bounded swap hypothesis, that section might say that the submitter can never change the target, adapter, route, recipient, input asset, output asset, per-run amount, output floor, cadence, run count, nonce, or expiry. It cannot create a new policy, sign as the owner, or move unrelated wallet assets.

This is the important shift: the agent may hold the trigger, but the signed policy holds the authority.

## Use Request a Zap as a design review

Once the map is specific, open [Request a Zap](https://www.0xzaps.com/request-a-zap).

The request asks for one workflow, its trigger, the protocols or assets involved, the guardrails, and the intended timeline. Share the workflow, not private keys, API keys, wallet secrets, or confidential strategy data.

The output is a human-reviewed, one-page authority map covering:

- The workflow and allowed trigger.
- Allowed targets and assets.
- Recipient and settlement direction.
- Spend, cadence, slippage, and lifetime limits.
- Revoke and recovery paths.
- Authority that must remain impossible.

Submitting the form is not an integration commitment. It does not deploy a contract, connect a wallet, reserve engineering work, or promise that the requested route is supported.

That last caveat matters. Some workflows cannot be represented safely by the deployed lineages. A useful review may conclude that a requested guard cannot currently be enforced, that a price source is unsuitable, or that the idea requires too much discretionary authority.

## What the paper trade proves—and what it does not

Virtual Trading can provide evidence about the quoted route and local accounting under its stated assumptions. It can help expose wrong asset direction, unrealistic sizing, missing price data, and a trigger that is too vague to evaluate.

It does not prove:

- That a live transaction would receive the same fill.
- That gas, ordering, MEV, liquidity, or chain conditions will remain stable.
- That the requested workflow is deployable by OpenZaps.
- That every desired guard is enforced onchain.
- That an adapter, oracle, token, wallet, or contract is safe.
- That OpenZaps has been externally audited.

A paper trade is a design instrument, not a safety certificate.

## Where a live pilot should begin

If the authority map survives review and the exact route is supported, the next step should be simulation-first and tightly capped. Review the encoded target, assets, recipient, amount, calldata shape, trigger, cadence, output limits, expiry, and recovery path before signing anything.

Use the smallest practical amount. Verify the deployed contracts and current documentation independently. Retain the transaction hash, receipt, contract address, and owner recovery evidence. Treat a submitted hash as evidence of broadcast, not confirmation.

OpenZaps narrows what a submitter can do. It does not remove smart-contract, adapter, oracle, wallet, market, or chain risk.

The workflow I want builders to adopt is straightforward:

1. Paper trade the exact route.
2. Write the market hypothesis in one sentence.
3. Draw every allowed field.
4. List every field the agent must never change.
5. Request the authority map.
6. Simulate and independently review before considering a capped live pilot.

Start without a wallet. Earn precision before authority.

## Try the two-step workflow

- [Practice in Virtual Trading](https://www.0xzaps.com/virtual-trading)
- [Request a human-reviewed Zap authority map](https://www.0xzaps.com/request-a-zap)
- [Read the OpenZaps security policy](https://github.com/0pen-Zaps/openzaps/blob/main/SECURITY.md)

*Not financial advice. No return, execution, integration, audit, or safety guarantee is implied.*
