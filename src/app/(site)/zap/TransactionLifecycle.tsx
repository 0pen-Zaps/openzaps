import { explorerTransaction } from "@/lib/robinhood";
import {
  transactionLifecycleStepStatuses,
  type TransactionLifecycleState,
} from "@/lib/transaction-lifecycle";
import type { Hex } from "viem";
import styles from "./app.module.css";

const STEPS = [
  {
    id: "preflight",
    title: "Preflight",
    detail: "Account, chain and contract simulation checked.",
  },
  {
    id: "wallet",
    title: "Wallet review",
    detail: "The exact signature or transaction stays user-confirmed.",
  },
  {
    id: "submit",
    title: "Onchain submit",
    detail: "A hash becomes inspectable as soon as the wallet broadcasts.",
  },
  {
    id: "verify",
    // "Postconditions" belongs to the contract: the Zap asserts those onchain,
    // inside the execution. What happens after a receipt is the app reading the
    // result back — the nonce, the balances, the owner and policy of a new Zap.
    title: "Receipt verify",
    detail: "Receipt status closes the broadcast loop; the result is then read back onchain.",
  },
] as const;

function summary(activity: TransactionLifecycleState | null): string {
  if (!activity) return "No wallet write is active. Every submission traces these four stages.";
  if (activity.stage === "wallet") return `${activity.label}: waiting for wallet review.`;
  if (activity.stage === "not-submitted") return `${activity.label}: nothing was submitted onchain.`;
  if (activity.stage === "submitted") return `${activity.label}: submitted and waiting for a receipt.`;
  if (activity.stage === "confirmed") return `${activity.label}: the onchain receipt is confirmed.`;
  if (activity.stage === "reverted") return `${activity.label}: the receipt reports a reverted transaction.`;
  return `${activity.label}: receipt polling was interrupted; inspect the transaction onchain.`;
}

function compactHash(hash: Hex): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function TransactionLifecycle({
  activity,
}: {
  activity: TransactionLifecycleState | null;
}): React.JSX.Element {
  const statuses = transactionLifecycleStepStatuses(activity?.stage ?? null);

  return (
    <section className={styles.lifecycle} aria-labelledby="transaction-lifecycle-title">
      <div className={styles.lifecycleHead}>
        {/* Not "execution": this traces every wallet write on the screen —
            wrapping, funding, recovery — not only the Zap's execution. */}
        <h3 id="transaction-lifecycle-title" className={styles.lifecycleTitle}>
          Transaction flight recorder
        </h3>
        <p className={styles.lifecycleSummary} aria-live="polite">{summary(activity)}</p>
      </div>

      <ol className={styles.lifecycleTrack}>
        {STEPS.map((step, index) => (
          <li className={styles.lifecycleStep} key={step.id} data-status={statuses[index]}>
            <span className={styles.lifecycleNode} aria-hidden="true">
              {statuses[index] === "done" ? "✓" : statuses[index] === "error" ? "!" : index + 1}
            </span>
            <div>
              <strong className={styles.lifecycleName}>{step.title}</strong>
              <small className={styles.lifecycleDetail}>{step.detail}</small>
            </div>
          </li>
        ))}
      </ol>

      {activity?.hash ? (
        <a
          className={styles.lifecycleHash}
          href={explorerTransaction(activity.hash)}
          target="_blank"
          rel="noreferrer"
        >
          <span data-status={activity.stage}>{activity.stage}</span>
          <strong>{activity.label}</strong>
          <code>{compactHash(activity.hash)} ↗</code>
        </a>
      ) : null}
    </section>
  );
}
