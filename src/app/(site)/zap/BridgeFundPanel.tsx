"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";

import {
  BRIDGE_SUBMISSION_RUNWAY_SECONDS,
  BRIDGE_ROUTES,
  bridgeApprovalAmounts,
  bridgeFeeBps,
  buildBridgeDeposit,
  baseChain,
  ensureBaseChain,
  erc20AllowanceAbi,
  fetchBridgeQuote,
  quoteIsStale,
  type BridgeQuote,
} from "@/lib/bridge";
import { getInjectedProvider, robinhoodChain } from "@/lib/robinhood";

type Phase =
  | { kind: "idle" }
  | { kind: "quoting" }
  | { kind: "quoted"; quote: BridgeQuote }
  | { kind: "submitting"; quote: BridgeQuote }
  | { kind: "submitted"; quote: BridgeQuote; hash: Hex }
  | { kind: "confirmed"; quote: BridgeQuote; hash: Hex }
  | { kind: "arrived"; quote: BridgeQuote; hash: Hex; balance: bigint }
  | { kind: "reverted"; quote: BridgeQuote; hash: Hex }
  | { kind: "error"; message: string };

type AllowanceCleanup = {
  account: Address;
  quote: BridgeQuote;
  allowance: bigint;
  status: "needed" | "revoking" | "error";
  message?: string;
};

const ROUTE = BRIDGE_ROUTES[0];
const destinationClient = createPublicClient({ chain: robinhoodChain, transport: http() });

function formatAmount(value: bigint, decimals: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals }).format(
    Number(formatUnits(value, decimals)),
  );
}

async function readDestinationBalance(capsule: Address): Promise<bigint> {
  return destinationClient.readContract({
    address: ROUTE.outputToken,
    abi: erc20AllowanceAbi,
    functionName: "balanceOf",
    args: [capsule],
  });
}

/**
 * Quote only the capsule's remaining funding requirement. Across's raw deposit
 * calldata is validated on the server and again in the browser before this
 * component offers it to the wallet. Arrival is proven from the destination
 * ERC-20 balance, not inferred from an origin transaction hash.
 */
export function BridgeFundPanel({
  capsule,
  fundingAsset,
  requiredAmount,
}: {
  capsule: Address;
  fundingAsset: Address;
  requiredAmount: bigint;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [allowanceCleanup, setAllowanceCleanup] = useState<AllowanceCleanup | null>(null);
  const [destinationBalance, setDestinationBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const quoteEpoch = useRef(0);
  const arrivalEpoch = useRef(0);

  const fundable = getAddress(fundingAsset) === ROUTE.outputToken;
  const remainingAmount = useMemo(
    () =>
      destinationBalance === null
        ? null
        : destinationBalance >= requiredAmount
          ? 0n
          : requiredAmount - destinationBalance,
    [destinationBalance, requiredAmount],
  );

  const refreshDestinationBalance = useCallback(async (): Promise<bigint> => {
    try {
      const balance = await readDestinationBalance(capsule);
      setDestinationBalance(balance);
      setBalanceError("");
      return balance;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBalanceError(`Could not read the capsule's ${ROUTE.outputSymbol} balance: ${message}`);
      throw error;
    }
  }, [capsule]);

  useEffect(() => {
    const mine = ++arrivalEpoch.current;
    void readDestinationBalance(capsule).then(
      (balance) => {
        if (arrivalEpoch.current !== mine) return;
        setDestinationBalance(balance);
        setBalanceError("");
      },
      (error: unknown) => {
        if (arrivalEpoch.current !== mine) return;
        const message = error instanceof Error ? error.message : String(error);
        setBalanceError(`Could not read the capsule's ${ROUTE.outputSymbol} balance: ${message}`);
      },
    );
    return () => {
      if (arrivalEpoch.current === mine) arrivalEpoch.current += 1;
    };
  }, [capsule]);

  const quote = useCallback(async () => {
    const needed = remainingAmount;
    if (needed === null) {
      setPhase({ kind: "error", message: "Refresh the destination balance before requesting a bridge quote." });
      return;
    }
    if (needed <= 0n) {
      setPhase({ kind: "idle" });
      return;
    }

    const provider = getInjectedProvider();
    if (!provider) {
      setPhase({ kind: "error", message: "No wallet is available in this browser." });
      return;
    }

    const mine = ++quoteEpoch.current;
    setPhase({ kind: "quoting" });
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const rawAccount = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof rawAccount !== "string" || !isAddress(rawAccount)) {
        throw new Error("The wallet returned no usable account.");
      }
      const next = await fetchBridgeQuote(ROUTE, needed, getAddress(rawAccount), capsule);
      if (mine !== quoteEpoch.current) return;
      setPhase({ kind: "quoted", quote: next });
    } catch (error) {
      if (mine !== quoteEpoch.current) return;
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [capsule, remainingAmount]);

  const waitForArrival = useCallback(
    async (current: BridgeQuote, hash: Hex): Promise<void> => {
      const mine = ++arrivalEpoch.current;
      const waitMs = Math.min(10 * 60_000, Math.max(2 * 60_000, current.estimatedFillSeconds * 30_000));
      const stopAt = Date.now() + waitMs;

      while (arrivalEpoch.current === mine && Date.now() < stopAt) {
        try {
          const balance = await refreshDestinationBalance();
          if (balance >= requiredAmount) {
            setPhase({ kind: "arrived", quote: current, hash, balance });
            return;
          }
        } catch {
          // The visible balance error carries the RPC failure. Keep polling
          // because a transient read failure says nothing about fill status.
        }
        await new Promise((resolve) => window.setTimeout(resolve, 5_000));
      }
    },
    [refreshDestinationBalance, requiredAmount],
  );

  const deposit = useCallback(
    async (current: BridgeQuote) => {
      if (
        quoteIsStale(
          current,
          Math.floor(Date.now() / 1_000),
          BRIDGE_SUBMISSION_RUNWAY_SECONDS,
        )
      ) {
        setPhase({
          kind: "error",
          message: "That bridge quote has too little time left. Quote again before depositing.",
        });
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
        if (getAddress(account) !== current.depositor) {
          throw new Error("The connected account changed after quoting. Quote again for this account.");
        }

        const baseClient = createPublicClient({ chain: baseChain, transport: http() });
        const balance = await baseClient.readContract({
          address: current.route.inputToken,
          abi: erc20AllowanceAbi,
          functionName: "balanceOf",
          args: [account],
        });
        if (balance < current.inputAmount) {
          throw new Error(
            `This account has ${formatAmount(balance, current.route.inputDecimals)} ${current.route.inputSymbol}; ` +
              `${formatAmount(current.inputAmount, current.route.inputDecimals)} is required.`,
          );
        }

        const allowance = await baseClient.readContract({
          address: current.route.inputToken,
          abi: erc20AllowanceAbi,
          functionName: "allowance",
          args: [account, current.spokePool],
        });
        // Never inherit a stale, wider approval. The Across calldata is bound
        // to one exact input amount, so its ERC-20 authority should be exact
        // too. Reset a non-zero mismatch first for tokens that require the
        // zero-before-change pattern, then approve only this quote's amount.
        const approvalAmounts = bridgeApprovalAmounts(allowance, current.inputAmount);
        for (const approvalAmount of approvalAmounts) {
          if (approvalAmount === 0n) {
            setAllowanceCleanup({
              account: getAddress(account),
              quote: current,
              allowance,
              status: "needed",
              message: "A previous Across allowance must be cleared before this exact quote can be approved.",
            });
            const reset = await wallet.writeContract({
              account,
              chain: baseChain,
              address: current.route.inputToken,
              abi: erc20AllowanceAbi,
              functionName: "approve",
              args: [current.spokePool, 0n],
            });
            const resetReceipt = await baseClient.waitForTransactionReceipt({ hash: reset });
            if (resetReceipt.status !== "success") {
              throw new Error("The stale Across allowance could not be reset to zero.");
            }
            setAllowanceCleanup(null);
            continue;
          }
          const approval = await wallet.writeContract({
            account,
            chain: baseChain,
            address: current.route.inputToken,
            abi: erc20AllowanceAbi,
            functionName: "approve",
            args: [current.spokePool, approvalAmount],
          });
          setAllowanceCleanup({
            account: getAddress(account),
            quote: current,
            allowance: approvalAmount,
            status: "needed",
            message: "The exact Across approval was submitted; its onchain allowance still needs to be consumed or revoked.",
          });
          const approvalReceipt = await baseClient.waitForTransactionReceipt({ hash: approval });
          if (approvalReceipt.status !== "success") {
            setAllowanceCleanup(null);
            throw new Error("The exact USDC approval reverted.");
          }
        }

        // From this point until the SpokePool consumes the deposit, a real
        // allowance exists independently of the deposit transaction. Keep an
        // explicit cleanup affordance alive across every later failure.
        setAllowanceCleanup({
          account: getAddress(account),
          quote: current,
          allowance: current.inputAmount,
          status: "needed",
        });

        if (
          quoteIsStale(
            current,
            Math.floor(Date.now() / 1_000),
            BRIDGE_SUBMISSION_RUNWAY_SECONDS,
          )
        ) {
          setPhase({
            kind: "error",
            message:
              "The bridge quote became stale while approvals were confirming. Quote again, or revoke the visible exact allowance.",
          });
          return;
        }
        const call = buildBridgeDeposit(current, account, capsule);
        await baseClient.call({ account, to: call.address, data: call.data, value: call.value });
        if (
          quoteIsStale(
            current,
            Math.floor(Date.now() / 1_000),
            BRIDGE_SUBMISSION_RUNWAY_SECONDS,
          )
        ) {
          setPhase({
            kind: "error",
            message:
              "The bridge quote became stale before wallet submission. Quote again, or revoke the visible exact allowance.",
          });
          return;
        }
        const hash = await wallet.sendTransaction({
          account,
          chain: baseChain,
          to: call.address,
          data: call.data,
          value: call.value,
        });
        setPhase({ kind: "submitted", quote: current, hash });

        const receipt = await baseClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          setPhase({ kind: "reverted", quote: current, hash });
          return;
        }
        try {
          const remainingAllowance = await baseClient.readContract({
            address: current.route.inputToken,
            abi: erc20AllowanceAbi,
            functionName: "allowance",
            args: [account, current.spokePool],
          });
          if (remainingAllowance === 0n) {
            setAllowanceCleanup(null);
          } else {
            setAllowanceCleanup({
              account: getAddress(account),
              quote: current,
              allowance: remainingAllowance,
              status: "needed",
              message: "The deposit confirmed, but a residual Across allowance remains.",
            });
          }
        } catch {
          setAllowanceCleanup((existing) =>
            existing
              ? {
                  ...existing,
                  message: "The deposit confirmed, but the remaining Across allowance could not be verified.",
                }
              : existing,
          );
        }
        setPhase({ kind: "confirmed", quote: current, hash });
        await waitForArrival(current, hash);
      } catch (error) {
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    },
    [capsule, waitForArrival],
  );

  const revokeBridgeAllowance = useCallback(async () => {
    const cleanup = allowanceCleanup;
    if (!cleanup || cleanup.status === "revoking") return;
    const provider = getInjectedProvider();
    if (!provider) {
      setAllowanceCleanup({ ...cleanup, status: "error", message: "No wallet is available to revoke the allowance." });
      return;
    }

    setAllowanceCleanup({ ...cleanup, status: "revoking" });
    try {
      await ensureBaseChain(provider);
      const wallet = createWalletClient({ chain: baseChain, transport: custom(provider) });
      const [account] = await wallet.requestAddresses();
      if (!account || getAddress(account) !== cleanup.account) {
        throw new Error(`Connect ${cleanup.account} on Base to revoke this allowance.`);
      }
      const baseClient = createPublicClient({ chain: baseChain, transport: http() });
      const hash = await wallet.writeContract({
        account,
        chain: baseChain,
        address: cleanup.quote.route.inputToken,
        abi: erc20AllowanceAbi,
        functionName: "approve",
        args: [cleanup.quote.spokePool, 0n],
      });
      const receipt = await baseClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The allowance revocation reverted.");
      setAllowanceCleanup(null);
    } catch (error) {
      setAllowanceCleanup({
        ...cleanup,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [allowanceCleanup]);

  if (!fundable) {
    return (
      <section aria-label="Fund from Base">
        <h3>Fund from Base</h3>
        <p role="note">
          This bridge delivers {ROUTE.outputSymbol}, but this capsule spends a different asset. Bridging it here would
          not fund the signed route, so this action is disabled.
        </p>
      </section>
    );
  }

  const active =
    phase.kind === "quoted" ||
    phase.kind === "submitting" ||
    phase.kind === "submitted" ||
    phase.kind === "confirmed" ||
    phase.kind === "arrived" ||
    phase.kind === "reverted"
      ? phase.quote
      : null;
  const inFlight =
    phase.kind === "quoting" ||
    phase.kind === "submitting" ||
    phase.kind === "submitted" ||
    phase.kind === "confirmed";
  const fullyFunded = remainingAmount === 0n;

  return (
    <section aria-label="Fund from Base">
      <h3>Fund from Base</h3>
      <p>
        Deliver Base {ROUTE.inputSymbol} as <strong>{ROUTE.outputSymbol}</strong> directly to this capsule over Across.
        The bridge stays outside the policy; the policy takes over only after the destination balance proves arrival.
      </p>

      <dl>
        <dt>Capsule needs</dt>
        <dd>
          {formatAmount(requiredAmount, ROUTE.outputDecimals)} {ROUTE.outputSymbol}
        </dd>
        <dt>Already on Robinhood Chain</dt>
        <dd>
          {destinationBalance === null
            ? "Checking…"
            : `${formatAmount(destinationBalance, ROUTE.outputDecimals)} ${ROUTE.outputSymbol}`}
        </dd>
        <dt>Still needed</dt>
        <dd>
          {remainingAmount === null
            ? "Checking…"
            : `${formatAmount(remainingAmount, ROUTE.outputDecimals)} ${ROUTE.outputSymbol}`}
        </dd>
        <dt>Destination</dt>
        <dd>
          <code>{capsule}</code>
        </dd>
      </dl>

      {balanceError ? <p role="alert">{balanceError}</p> : null}
      {fullyFunded ? (
        <p role="status">
          This capsule already has enough {ROUTE.outputSymbol} for its frozen input. No bridge deposit is needed.
        </p>
      ) : null}

      {active ? (
        <dl>
          <dt>Spend on Base</dt>
          <dd>
            {formatAmount(active.inputAmount, active.route.inputDecimals)} {active.route.inputSymbol}
          </dd>
          <dt>Minimum arrival</dt>
          <dd>
            {formatAmount(active.outputAmount, active.route.outputDecimals)} {active.route.outputSymbol}
          </dd>
          <dt>Quoted spread</dt>
          <dd>{bridgeFeeBps(active)} bps</dd>
          <dt>Estimated fill</dt>
          <dd>{active.estimatedFillSeconds > 0 ? `~${active.estimatedFillSeconds}s` : "under a second"}</dd>
        </dl>
      ) : null}

      {active && !active.providerAuthenticated ? (
        <p role="note">
          Across accepted this quote without production API credentials. It is still validated end to end, but the
          provider may rate-limit new quotes until credentials are configured.
        </p>
      ) : null}

      {phase.kind === "submitted" ? (
        <p role="status">
          Deposit submitted on Base —{" "}
          <a href={`${baseChain.blockExplorers.default.url}/tx/${phase.hash}`} rel="noreferrer" target="_blank">
            view transaction
          </a>
          . Waiting for its origin-chain receipt.
        </p>
      ) : null}
      {phase.kind === "confirmed" ? (
        <p role="status">
          Deposit confirmed on Base. Waiting for the Robinhood Chain {phase.quote.route.outputSymbol} balance to prove
          arrival.
        </p>
      ) : null}
      {phase.kind === "arrived" ? (
        <p role="status">
          Arrived: the capsule now holds {formatAmount(phase.balance, phase.quote.route.outputDecimals)}{" "}
          {phase.quote.route.outputSymbol}. Its signed execution can proceed.
        </p>
      ) : null}
      {phase.kind === "reverted" ? (
        <p role="alert">
          The Base deposit reverted. Nothing was bridged; quote again before retrying.{" "}
          <a href={`${baseChain.blockExplorers.default.url}/tx/${phase.hash}`} rel="noreferrer" target="_blank">
            View transaction
          </a>
          .
        </p>
      ) : null}
      {phase.kind === "error" ? <p role="alert">{phase.message}</p> : null}

      {allowanceCleanup ? (
        <div role="alert">
          <p>
            {allowanceCleanup.message ??
              `An exact ${formatAmount(
                allowanceCleanup.allowance,
                allowanceCleanup.quote.route.inputDecimals,
              )} ${allowanceCleanup.quote.route.inputSymbol} allowance to Across is still present on Base.`}{" "}
            If the deposit is still pending, revoking now will make it fail instead of spending the token.
          </p>
          <button
            className="btn"
            disabled={allowanceCleanup.status === "revoking"}
            onClick={() => void revokeBridgeAllowance()}
            type="button"
          >
            {allowanceCleanup.status === "revoking" ? "Revoking allowance…" : "Revoke Across allowance"}
          </button>
        </div>
      ) : null}

      {!fullyFunded && phase.kind === "quoted" ? (
        <button className="btn btnPrimary" onClick={() => void deposit(phase.quote)} type="button">
          Bridge {formatAmount(phase.quote.inputAmount, phase.quote.route.inputDecimals)}{" "}
          {phase.quote.route.inputSymbol}
        </button>
      ) : !fullyFunded ? (
        <button
          className="btn btnPrimary"
          disabled={inFlight || remainingAmount === null}
          onClick={() => void quote()}
          type="button"
        >
          {phase.kind === "quoting" ? "Quoting exact funding…" : "Quote remaining funding"}
        </button>
      ) : null}

      <button
        className="btn"
        disabled={inFlight}
        onClick={() => void refreshDestinationBalance().catch(() => undefined)}
        type="button"
      >
        Refresh destination balance
      </button>
    </section>
  );
}
