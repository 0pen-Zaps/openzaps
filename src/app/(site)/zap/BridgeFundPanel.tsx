"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";

import {
  BRIDGE_ROUTES,
  bridgeFeeBps,
  buildBridgeDeposit,
  baseChain,
  ensureBaseChain,
  erc20AllowanceAbi,
  fetchBridgeQuote,
  quoteIsStale,
  type BridgeQuote,
} from "@/lib/bridge";
import { getInjectedProvider } from "@/lib/robinhood";

/**
 * Fund a capsule from Base.
 *
 * Self-contained: it takes a capsule address and never touches the sign-and-run
 * console's state. The bridge is not part of the policy, so it must not look
 * like part of the policy — this panel is about getting an ERC-20 into an
 * address, and everything the capsule enforces happens afterwards.
 *
 * The lifecycle is modelled honestly rather than collapsed into a spinner:
 * submitted-with-hash, confirmed-on-Base, and arrived-on-4663 are three
 * different facts and only the first two are observable from here.
 */

type Phase =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "quoted"; quote: BridgeQuote }
  | { kind: "submitting"; quote: BridgeQuote }
  | { kind: "submitted"; quote: BridgeQuote; hash: Hex }
  | { kind: "confirmed"; quote: BridgeQuote; hash: Hex }
  | { kind: "reverted"; quote: BridgeQuote; hash: Hex }
  | { kind: "error"; message: string };

const ROUTE = BRIDGE_ROUTES[0];

export function BridgeFundPanel({ capsule, fundingAsset }: { capsule: Address; fundingAsset: Address }) {
  const [amount, setAmount] = useState("100");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /**
   * Guards against an in-flight quote landing after the amount moved on. Each
   * quote captures the epoch it started in; a response from a stale epoch is
   * dropped rather than shown against a figure the user has since changed.
   */
  const epoch = useRef(0);

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

  /**
   * A capsule spends exactly the asset its frozen policy names. Bridging any
   * OTHER token into it does not fund it: the tokens land, no step can consume
   * them, and because they are absent from the policy's `trackedAssets` the
   * product's own recover button — which passes that list to `emergencyExit` —
   * will not return them either. Retrieving them means hand-crafting a call
   * outside the app.
   *
   * So the funding asset is a REQUIRED prop and a mismatch renders a refusal.
   * The caller cannot forget the check, because there is no way to mount this
   * component without stating what the capsule actually spends.
   */
  const fundable = getAddress(fundingAsset) === ROUTE.outputToken;

  const quote = useCallback(async () => {
    if (!parsedAmount) {
      setPhase({
        kind: "error",
        message: `Enter a ${ROUTE.inputSymbol} amount with at most ${ROUTE.inputDecimals} decimals.`,
      });
      return;
    }
    const mine = ++epoch.current;
    setPhase({ kind: "quoting" });
    try {
      const next = await fetchBridgeQuote(ROUTE, parsedAmount);
      if (mine !== epoch.current) return; // the amount changed under us
      setPhase({ kind: "quoted", quote: next });
    } catch (error) {
      if (mine !== epoch.current) return;
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [parsedAmount]);

  const deposit = useCallback(
    async (current: BridgeQuote) => {
      // Across prices a quote at a block and the relayer will not honour an
      // expired one. Re-quoting is free; depositing against a dead quote is not.
      if (quoteIsStale(current)) {
        setPhase({ kind: "error", message: "That bridge quote has expired. Quote again before depositing." });
        return;
      }
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
        // Simulate first: a deposit that would revert should fail here, with the
        // contract's own reason, rather than after the user has paid gas.
        await publicClient.simulateContract({
          account,
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
        });
        const hash = await wallet.writeContract({
          account,
          chain: baseChain,
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
        });
        setPhase({ kind: "submitted", quote: current, hash });

        // A hash is proof of submission, never of success. Resolve it.
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        setPhase(
          receipt.status === "success"
            ? { kind: "confirmed", quote: current, hash }
            : { kind: "reverted", quote: current, hash },
        );
      } catch (error) {
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    },
    [capsule],
  );

  if (!fundable) {
    return (
      <section aria-label="Fund from Base">
        <h3>Fund from Base</h3>
        <p role="note">
          This bridge delivers {ROUTE.outputSymbol}, and this capsule&rsquo;s policy spends a different asset. Bridging{" "}
          {ROUTE.outputSymbol} here would not fund it — no step could spend the arriving tokens, and because they are
          not among the policy&rsquo;s tracked assets, the recover button would not return them either. Fund this
          capsule with the asset its own route names.
        </p>
      </section>
    );
  }

  const inFlight = phase.kind === "quoting" || phase.kind === "submitting" || phase.kind === "submitted";
  const active =
    phase.kind === "quoted" ||
    phase.kind === "submitting" ||
    phase.kind === "submitted" ||
    phase.kind === "confirmed" ||
    phase.kind === "reverted"
      ? phase.quote
      : null;

  return (
    <section aria-label="Fund from Base">
      <h3>Fund from Base</h3>
      <p>
        Bridges {ROUTE.inputSymbol} on Base into <strong>{ROUTE.outputSymbol}</strong> at this capsule&rsquo;s address
        over Across, usually in a few seconds. The bridge runs outside the capsule and is not bound by the signed policy
        — what the policy binds begins once the {ROUTE.outputSymbol} arrives.
      </p>

      <label htmlFor="bridge-amount">Amount ({ROUTE.inputSymbol} on Base)</label>
      <input
        disabled={inFlight}
        id="bridge-amount"
        inputMode="decimal"
        onChange={(event) => {
          setAmount(event.target.value);
          epoch.current += 1; // invalidate any quote still in flight
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
          . Waiting for confirmation; a hash is proof of submission, not of success.
        </p>
      ) : null}

      {phase.kind === "confirmed" ? (
        <p role="status">
          Deposit confirmed on Base —{" "}
          <a href={`${baseChain.blockExplorers.default.url}/tx/${phase.hash}`} rel="noreferrer" target="_blank">
            view transaction
          </a>
          . The relayer still has to fill it on Robinhood Chain; the capsule can only run once the{" "}
          {phase.quote.route.outputSymbol} is actually in it.
        </p>
      ) : null}

      {phase.kind === "reverted" ? (
        <p role="alert">
          The deposit reverted on Base —{" "}
          <a href={`${baseChain.blockExplorers.default.url}/tx/${phase.hash}`} rel="noreferrer" target="_blank">
            view transaction
          </a>
          . Nothing was bridged. Quote again before retrying.
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
        <button className="btn btnPrimary" disabled={inFlight || !parsedAmount} onClick={() => void quote()} type="button">
          {phase.kind === "quoting" ? "Quoting…" : "Quote bridge"}
        </button>
      )}
    </section>
  );
}
