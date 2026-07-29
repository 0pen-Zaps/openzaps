"use client";

import { useState } from "react";
import { isAddress } from "viem";

import type { ExecutorScorecardPage } from "@/lib/scorecard-server";
import styles from "./evals.module.css";

type ScorecardResponse = Partial<ExecutorScorecardPage> & {
  error?: string;
};

export function ExecutorScorecardLookup(): React.JSX.Element {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<ExecutorScorecardPage | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const lookup = async (): Promise<void> => {
    const candidate = address.trim();
    if (!isAddress(candidate) || loading) {
      setStatus("Enter a valid EVM executor address.");
      return;
    }
    setLoading(true);
    setResult(null);
    setStatus("");
    try {
      const response = await fetch(`/api/executors/${candidate}/scorecard?limit=10`, {
        cache: "no-store",
      });
      const body = (await response.json()) as ScorecardResponse;
      if (!response.ok || !body.scorecard || !Array.isArray(body.history)) {
        setStatus(body.error ?? "The scorecard could not be read.");
        return;
      }
      setResult(body as ExecutorScorecardPage);
      setStatus(
        body.scorecard.attempts === 0
          ? "No reference-executor receipts are recorded for this address."
          : `Loaded ${body.scorecard.attempts} independently verified attempt(s).`,
      );
    } catch {
      setStatus("The scorecard could not be reached.");
    } finally {
      setLoading(false);
    }
  };

  const scorecard = result?.scorecard;
  return (
    <div className={styles.shell}>
      <div className={styles.form}>
        <label htmlFor="executor-scorecard-address">Executor address</label>
        <div className={styles.controls}>
          <input
            id="executor-scorecard-address"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="0x…"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setResult(null);
              setStatus("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void lookup();
            }}
          />
          <button type="button" onClick={() => void lookup()} disabled={loading}>
            {loading ? "Checking…" : "Check scorecard"}
          </button>
        </div>
      </div>

      {scorecard ? (
        <dl className={styles.metrics}>
          <div><dt>Executor</dt><dd title={scorecard.executor}>{shortAddress(scorecard.executor)}</dd></div>
          <div><dt>Attempts</dt><dd>{scorecard.attempts}</dd></div>
          <div><dt>Finalized</dt><dd>{scorecard.finalized}</dd></div>
          <div><dt>Reverted</dt><dd>{scorecard.reverted}</dd></div>
          <div>
            <dt>Reliability</dt>
            <dd>{scorecard.reliabilityBps === null ? "No sample" : `${(scorecard.reliabilityBps / 100).toFixed(2)}%`}</dd>
          </div>
          <div><dt>Unique Zaps</dt><dd>{scorecard.uniqueZaps}</dd></div>
          <div><dt>Last block</dt><dd>{scorecard.lastBlock ?? "None"}</dd></div>
        </dl>
      ) : null}

      {result?.history.length ? (
        <div className={styles.history}>
          <h3>Latest verified receipts</h3>
          {result.history.map((receipt) => (
            <a
              href={`https://robinhoodchain.blockscout.com/tx/${receipt.txHash}`}
              target="_blank"
              rel="noreferrer"
              key={receipt.txHash}
            >
              <span data-outcome={receipt.outcome}>{receipt.outcome}</span>
              <code>{shortHash(receipt.txHash)}</code>
              <small>block {receipt.blockNumber}</small>
            </a>
          ))}
        </div>
      ) : null}

      <p className={styles.status} aria-live="polite">{status}</p>
    </div>
  );
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}
