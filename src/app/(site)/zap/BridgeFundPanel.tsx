"use client";

import { useCallback, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, formatUnits, http, parseUnits, type Address, type Hex } from "viem";

import {
  BRIDGE_ROUTES,
  bridgeFeeBps,
  buildBridgeDeposit,
  baseChain,
  ensureBaseChain,
  erc20AllowanceAbi,
  fetchBridgeQuote,
  type BridgeQuote,
} from "@/lib/bridge";
import { getInjectedProvider } from "@/lib/robinhood";

/**
 * Fund a capsule from Base.
 *
 * Deliberately self-contained: it takes a capsule address and never touches the
 * sign-and-run console's state. The bridge is not part of the policy, so it
 * must not look like part of the policy — this panel is about getting an ERC-20
 * into an address, and everything the capsule enforces happens afterwards.
 *
 * The lifecycle is modelled honestly rather than collapsed into a spinner: a
 * submitted deposit has a hash and is NOT yet an arrival, and an arrival is not
 * yet an executed Zap. Each is shown as its own state.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "quoted"; quote: BridgeQuote }
  | { kind: "submitting"; quote: BridgeQuote }
  | { kind: "submitted"; quote: BridgeQuote; hash: Hex }
  | { kind: "error"; message: string };

const ROUTE = BRIDGE_ROUTES[0];

export function BridgeFundPanel({ capsule }: { capsule: Address }) {
  const [amount, setAmount] = useState("100");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const parsedAmount = useMemo(() => {
    const raw = amount.trim();
    if (!/^\d+(?:\.\d*)?$/.test(raw)) return null;
    try {
      const value = parseUnits(raw, ROUTE.inputDecimals);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  }, [amount]);

  const quote = useCallback(async () => {
    if (!parsedAmount) {
      setPhase({ kind: "error", message: `Enter a ${ROUTE.inputSymbol} amount with at most ${ROUTE.inputDecimals} decimals.` });
      return;
    }
    setPhase({ kind: "quoting" });
    try {
      setPhase({ kind: "quoted", quote: await fetchBridgeQuote(ROUTE, parsedAmount) });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [parsedAmount]);

  const deposit = useCallback(
    async (current: BridgeQuote) => {
      const provider = getInjectedProvider();
      if (!provider) {
        setPhase({ kind: "error", message: "No wallet is available in this browser." });
        return;
      }
      setPhase({ kind: "submitting", quote: current });
      try {
        await ensureBaseChain(provider);
        const wallet = createWalletClient({ chain: baseChain, transport: custom(provider) });
        const [account] = await wallet.requestAddresses();
        if (!account) throw new Error("The wallet returned no account to deposit from.");

        const publicClient = createPublicClient({ chain: baseChain, transport: http() });

        // Across pulls the input token, so it needs an allowance. Only the
        // shortfall is requested, and only when there is one.
        const allowance = await publicClient.readContract({
          address: current.route.inputToken,
          abi: erc20AllowanceAbi,
          functionName: "allowance",
          args: [account, current.spokePool],
        });
        if (allowance < current.inputAmount) {
          const approval = await wallet.writeContract({
            account,
            chain: baseChain,
            address: current.route.inputToken,
            abi: erc20AllowanceAbi,
            functionName: "approve",
            args: [current.spokePool, current.inputAmount],
          });
          await publicClient.waitForTransactionReceipt({ hash: approval });
        }

        const call = buildBridgeDeposit(current, account, capsule);
        const hash = await wallet.writeContract({
          account,
          chain: baseChain,
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
        });
        setPhase({ kind: "submitted", quote: current, hash });
      } catch (error) {
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    },
    [capsule],
  );

  const active = phase.kind === "quoted" || phase.kind === "submitting" || phase.kind === "submitted" ? phase.quote : null;

  return (
    <section aria-label="Fund from Base">
      <h3>Fund from Base</h3>
      <p>
        Bridges {ROUTE.inputSymbol} on Base into <strong>{ROUTE.outputSymbol}</strong> at this capsule&rsquo;s address over
        Across, usually in a few seconds. The bridge runs outside the capsule and is not bound by the signed policy —
        what the policy binds begins once the {ROUTE.outputSymbol} arrives.
      </p>

      <label htmlFor="bridge-amount">Amount ({ROUTE.inputSymbol} on Base)</label>
      <input
        id="bridge-amount"
        inputMode="decimal"
        onChange={(event) => {
          setAmount(event.target.value);
          setPhase({ kind: "idle" });
        }}
        placeholder="100"
        value={amount}
      />

      <p>
        Destination: <code>{capsule}</code>
      </p>

      {active ? (
        <dl>
          <dt>Arrives</dt>
          <dd>
            {formatUnits(active.outputAmount, active.route.outputDecimals)} {active.route.outputSymbol}
          </dd>
          <dt>Bridge fee</dt>
          <dd>{bridgeFeeBps(active)} bps</dd>
          <dt>Estimated fill</dt>
          <dd>{active.estimatedFillSeconds > 0 ? `~${active.estimatedFillSeconds}s` : "under a second"}</dd>
        </dl>
      ) : null}

      {phase.kind === "submitted" ? (
        <p role="status">
          Deposit submitted on Base —{" "}
          <a href={`${baseChain.blockExplorers.default.url}/tx/${phase.hash}`} rel="noreferrer" target="_blank">
            view transaction
          </a>
          . A hash is proof of submission, not of arrival. The capsule can only run once the{" "}
          {phase.quote.route.outputSymbol} is actually in it.
        </p>
      ) : null}

      {phase.kind === "error" ? <p role="alert">{phase.message}</p> : null}

      {phase.kind === "quoted" || phase.kind === "submitting" ? (
        <button
          className="btn btnPrimary"
          disabled={phase.kind === "submitting"}
          onClick={() => void deposit(phase.quote)}
          type="button"
        >
          {phase.kind === "submitting" ? "Confirm in wallet…" : `Bridge ${amount} ${ROUTE.inputSymbol}`}
        </button>
      ) : (
        <button
          className="btn btnPrimary"
          disabled={phase.kind === "quoting" || !parsedAmount}
          onClick={() => void quote()}
          type="button"
        >
          {phase.kind === "quoting" ? "Quoting…" : "Quote bridge"}
        </button>
      )}
    </section>
  );
}
