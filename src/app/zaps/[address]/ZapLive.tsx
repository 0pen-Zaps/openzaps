"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, type Address } from "viem";

import { CopyButton } from "@/components/CopyButton";
import { SHAPE_COLOR, SHAPE_LABEL, type FlowShape } from "@/lib/blocks";
import { explorerAddress, explorerTransaction } from "@/lib/robinhood";
import type { ZapDetailPayload, ZapPolicyView } from "@/lib/zap";
import { BlockGlyph } from "@/app/build/BlockGlyph";
import styles from "../zaps.module.css";

type LiveState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; data: ZapDetailPayload; staleSince: string | null };

const LIFECYCLE_COPY: Record<ZapDetailPayload["lifecycle"], string> = {
  created: "Deployed, never funded",
  funded: "Holding a balance",
  executed: "Executed",
  recovered: "Swept by emergency exit",
};

/**
 * The whole detail body, server-rendered from `initial` and then repolled.
 *
 * Everything lives in one component on purpose: provenance, policy, and stats
 * all come from a single block-pinned snapshot, and splitting them across a
 * server half and a client half would let the page show a policy read at one
 * block next to balances read at another.
 */
export function ZapLive({
  address,
  initial,
}: {
  address: Address;
  initial: ZapDetailPayload | null;
}): React.JSX.Element {
  const [state, setState] = useState<LiveState>(
    initial ? { status: "ready", data: initial, staleSince: null } : { status: "loading" },
  );
  const requestSeq = useRef(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    setRefreshing(true);
    try {
      const response = await fetch(`/api/zaps/${address}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as ZapDetailPayload;
      if (seq !== requestSeq.current) return; // a late response must never overwrite fresher data
      setState({ status: "ready", data, staleSince: null });
    } catch {
      if (seq !== requestSeq.current) return;
      setState((current) =>
        current.status === "ready"
          ? { ...current, staleSince: current.staleSince ?? new Date().toISOString() }
          : { status: "unavailable" },
      );
    } finally {
      if (seq === requestSeq.current) setRefreshing(false);
    }
  }, [address]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [load]);

  if (state.status === "loading") {
    return (
      <section className={`container ${styles.panel}`} aria-label="Zap detail">
        <p className={styles.empty}>Reading this zap&apos;s policy, balances, and logs from Robinhood Chain…</p>
        <div aria-hidden className={styles.skelGrid}>
          {Array.from({ length: 6 }, (_, i) => (
            <div className={styles.skelCard} key={i} style={{ "--row-delay": `${-i * 0.14}s` } as React.CSSProperties}>
              <i className="skeleton" />
              <i className="skeleton" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (state.status === "unavailable") {
    return (
      <section className={`container ${styles.panel}`} aria-label="Zap detail">
        <div className={styles.unavailable} role="alert">
          <p>
            The Robinhood RPC reads for this address failed, so its onchain state is unavailable. The factory
            check is one of the reads that failed, so not even &ldquo;this is a deployed capsule&rdquo; is
            claimed here. A stale balance or a zeroed execution count would each be a claim about the chain
            that nobody verified. Nothing is shown instead.
          </p>
          <button
            className="btn btnGhost"
            onClick={() => {
              setState({ status: "loading" });
              void load();
            }}
            type="button"
          >
            <span>Retry</span>
          </button>
        </div>
      </section>
    );
  }

  const { data, staleSince } = state;
  const { policy, provenance, stats, balances, executions, recoveries } = data;
  const verified = policy.canonicalClone && policy.hashMatches;
  const chain = policyChain(policy);
  const feeTotals = Object.entries(stats.feeByAsset).filter(([, raw]) => raw !== "0");
  const recoveredTotals = totalsByAsset(recoveries);

  return (
    <>
      <section className={`container ${styles.verifyStrip}`} aria-label="Verification">
        <div className={styles.verifyMain}>
          <span className={styles.badge} data-verified={verified}>
            {verified ? "✓ Verified onchain" : "⚠ Unverified shape"}
          </span>
          <p>
            {verified
              ? "The factory's own ZapCreated log names this address. Its runtime is the EIP-1167 clone of the canonical implementation. The policy it exposes rehashes to the policyHash it committed to."
              : "The factory created this address, but at least one integrity check does not hold. Every failing check is listed below. Nothing has been rounded off or assumed."}
          </p>
        </div>
        <dl className={styles.verifyFacts}>
          <div>
            <dt>Read at block</dt>
            <dd>{Number(data.headBlock).toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>Snapshot taken</dt>
            <dd suppressHydrationWarning>{new Date(data.readAt).toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>Lifecycle</dt>
            <dd>{LIFECYCLE_COPY[data.lifecycle]}</dd>
          </div>
        </dl>
        <p className={styles.refreshLine}>
          {refreshing && <span aria-hidden className={`spinner ${styles.updatedSpinner}`} />}
          Every contract read and log query on this page is pinned to that one block, so the policy, the
          balances, and the event history describe the same moment. Nothing here is estimated or priced.
        </p>
      </section>

      <div aria-live="polite" className="container">
        {staleSince && (
          <div className={styles.staleWarning}>
            Refresh has been failing since{" "}
            <span suppressHydrationWarning>{new Date(staleSince).toLocaleTimeString("en-US")}</span> — everything
            below is the last verified snapshot, read at block{" "}
            {Number(data.headBlock).toLocaleString("en-US")}.
          </div>
        )}
      </div>

      <section className={`container ${styles.panel}`} aria-labelledby="what-this-does">
        <header className={styles.panelHead}>
          <span className="eyebrow">What this zap does</span>
          <h2 id="what-this-does">The deployed chain.</h2>
          <p>
            The same block vocabulary the <Link href="/build">builder</Link>{" "}
            uses, drawn from this capsule&apos;s own policy fields rather than from a template. Connectors are
            coloured by the shape of value moving along them.
          </p>
        </header>

        {policy.deviations.length > 0 && (
          <div className={styles.deviations} role="alert">
            <strong>This capsule departs from the one route the live contracts support.</strong>
            <ul>
              {policy.deviations.map((deviation) => (
                <li key={deviation}>{deviation}</li>
              ))}
            </ul>
          </div>
        )}

        {chain ? (
          <div className={styles.chain} data-standard={policy.matchesLiveRoute}>
            {chain.map((node, index) => (
              <div className={styles.slotGroup} key={node.key}>
                {index > 0 && (
                  <div
                    className={styles.joint}
                    data-status={node.incoming ? "ok" : "unknown"}
                    style={{ "--accent": node.incoming ? SHAPE_COLOR[node.incoming] : "#ff7a90" } as React.CSSProperties}
                  >
                    <span className={styles.jointLine} />
                    <span className={styles.jointLabel}>
                      {node.incoming ? SHAPE_LABEL[node.incoming] : "unresolved"}
                    </span>
                  </div>
                )}
                <article
                  className={styles.card}
                  data-kind={node.kind}
                  style={{ "--accent": SHAPE_COLOR[node.accent] } as React.CSSProperties}
                >
                  <span className={styles.cardGlyph}>
                    <BlockGlyph name={node.glyph} className={styles.glyph} />
                  </span>
                  <div className={styles.cardText}>
                    <strong>{node.title}</strong>
                    <span>{node.detail}</span>
                  </div>
                  {node.link && (
                    <a className={styles.cardLink} href={explorerAddress(node.link)} target="_blank" rel="noreferrer">
                      {shortAddress(node.link)} ↗
                    </a>
                  )}
                </article>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.empty}>
            This zap exposes no step, so there is no chain to draw. The policy fields it does expose are listed
            below exactly as the contract stores them.
          </p>
        )}

        {policy.stepCount !== "1" && (
          <p className={styles.note}>
            The zap declares {policy.stepCount} steps. Only step 0 is shown: it is the only one this snapshot
            read. The rest are not guessed at.
          </p>
        )}

        <dl className={styles.factGrid}>
          <Fact label="Owner">
            <AddressValue address={policy.owner} />
          </Fact>
          <Fact label="Recipient">
            <AddressValue address={policy.recipient} />
          </Fact>
          <Fact label="Relayer fee cap">
            {policy.maxRelayerFeeCap === "0" ? (
              <span>0 — no execution of this policy can pay a relayer fee.</span>
            ) : (
              <Amount raw={policy.maxRelayerFeeCap} symbol={policy.outputSymbol ?? ""} />
            )}
          </Fact>
          <Fact label="Optimization">
            <span>{policy.optimization ? "Enabled" : "Disabled"}</span>
          </Fact>
          <Fact label="Tracked assets">
            <span className={styles.assetList}>
              {policy.trackedAssets.length === 0
                ? "None"
                : policy.trackedAssets.map((asset) => (
                    <a key={asset} href={explorerAddress(asset)} target="_blank" rel="noreferrer">
                      {shortAddress(asset)} ↗
                    </a>
                  ))}
            </span>
          </Fact>
          <Fact label="Policy hash">
            <CopyButton className={styles.hexCopy} value={policy.policyHash} label={shortHex(policy.policyHash)} />
            <span className={styles.factNote}>
              {policy.hashMatches ? "Rehashes from the live policy fields." : "Does not match the exposed policy."}
            </span>
          </Fact>
        </dl>
      </section>

      <section className={`container ${styles.panel}`} aria-labelledby="what-happened">
        <header className={styles.panelHead}>
          <span className="eyebrow">Measured, not modelled</span>
          <h2 id="what-happened">What has happened.</h2>
          <p>
            Counts and totals come only from this contract&apos;s own Executed and EmergencyExit logs. No USD
            value, token price, PnL, APY, or success rate appears on this page. A reverted execution emits no
            log at all, so a success rate computed from these logs would be unfalsifiable, and none is shown.
          </p>
        </header>

        <div className={styles.metrics}>
          <Metric label="Executions" value={String(stats.executionCount)} />
          <Metric label="Emergency exits" value={String(stats.recoveryCount)} />
          <ExecutionTime count={stats.executionCount} label="First execution" timestamp={stats.firstExecutionAt} />
          <ExecutionTime count={stats.executionCount} label="Last execution" timestamp={stats.lastExecutionAt} />
        </div>

        <div className={styles.totalsGrid}>
          <div className={styles.totalsCard}>
            <h3>Produced by executions</h3>
            {Object.keys(stats.amountOutByAsset).length === 0 ? (
              <p className={styles.empty}>None yet — this zap has never emitted an Executed log.</p>
            ) : (
              <ul className={styles.totalsList}>
                {Object.entries(stats.amountOutByAsset).map(([symbol, net]) => {
                  const fee = stats.feeByAsset[symbol] ?? "0";
                  const gross = (BigInt(net) + BigInt(fee)).toString();
                  return (
                    <li key={symbol}>
                      <Amount raw={net} symbol={symbol} />
                      <span className={styles.totalsNote}>
                        net to the recipient · gross out of the adapter{" "}
                        <Amount raw={gross} symbol={symbol} inline />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className={styles.totalsCard}>
            <h3>Relayer fee taken</h3>
            {feeTotals.length === 0 ? (
              <p className={styles.empty}>
                {policy.maxRelayerFeeCap === "0"
                  ? "Zero, and not because none happened to be taken. This policy commits maxRelayerFeeCap = 0, so no execution of it can pay a relayer fee. The bound comes from the policy hash, not from a measurement."
                  : "No fee appears in any Executed log for this zap."}
              </p>
            ) : (
              <ul className={styles.totalsList}>
                {feeTotals.map(([symbol, raw]) => (
                  <li key={symbol}>
                    <Amount raw={raw} symbol={symbol} />
                    <span className={styles.totalsNote}>summed from the fee field of each Executed log</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={styles.totalsCard}>
            <h3>Swept by emergency exit</h3>
            {recoveredTotals.length === 0 ? (
              <p className={styles.empty}>None — the owner has never pulled assets back out of this capsule.</p>
            ) : (
              <ul className={styles.totalsList}>
                {recoveredTotals.map(([symbol, raw]) => (
                  <li key={symbol}>
                    <Amount raw={raw} symbol={symbol} />
                    <span className={styles.totalsNote}>returned to the owner</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={styles.totalsCard}>
            <h3>Held right now</h3>
            <ul className={styles.totalsList}>
              <li>
                <Amount raw={balances.weth} symbol="aeWETH" />
              </li>
              <li>
                <Amount raw={balances.zaps} symbol="0xZAPS" />
              </li>
              <li>
                <Amount raw={balances.native} symbol="ETH" />
              </li>
            </ul>
            <span className={styles.totalsNote}>
              Custody balances at block {Number(data.headBlock).toLocaleString("en-US")}.
            </span>
          </div>
        </div>
      </section>

      <section className={`container ${styles.panel}`} aria-labelledby="event-log">
        <header className={styles.panelHead}>
          <span className="eyebrow">Event log</span>
          <h2 id="event-log">Every execution and exit.</h2>
        </header>

        <h3 className={styles.rowsHead}>Executions</h3>
        {executions.length === 0 ? (
          <p className={styles.empty}>None yet.</p>
        ) : (
          <div className={styles.rows}>
            {executions.map((execution, i) => (
              <a
                className={styles.row}
                href={explorerTransaction(execution.txHash)}
                key={`${execution.txHash}:${execution.logIndex}`}
                style={{ "--row-delay": `${Math.min(i, 10) * 45}ms` } as React.CSSProperties}
                target="_blank"
                rel="noreferrer"
              >
                <span className={styles.rowType} data-type="executed">
                  Executed
                </span>
                <span className={styles.rowDetail}>
                  <Amount raw={execution.amountOut} symbol={execution.assetSymbol} inline /> to{" "}
                  {shortAddress(execution.recipient)}
                  {execution.fee !== "0" && (
                    <>
                      {" · fee "}
                      <Amount raw={execution.fee} symbol={execution.assetSymbol} inline />
                    </>
                  )}
                  {/* A 78-digit nonce would swallow the row, and half of one is
                      not a nonce, so the full value stays in the title. */}
                  <span className={styles.rowNonce} title={`nonce ${execution.nonce}`}>
                    nonce {shortDigits(execution.nonce)}
                  </span>
                </span>
                <span className={styles.rowTime} suppressHydrationWarning>
                  {execution.timestamp
                    ? localDate(execution.timestamp)
                    : `block ${Number(execution.blockNumber).toLocaleString("en-US")}`}{" "}
                  <span aria-label="opens transaction on Blockscout in a new tab">↗</span>
                </span>
              </a>
            ))}
          </div>
        )}

        <h3 className={styles.rowsHead}>Emergency exits</h3>
        {recoveries.length === 0 ? (
          <p className={styles.empty}>None yet.</p>
        ) : (
          <div className={styles.rows}>
            {recoveries.map((recovery, i) => (
              <a
                className={styles.row}
                href={explorerTransaction(recovery.txHash)}
                key={`${recovery.txHash}:${recovery.logIndex}`}
                style={{ "--row-delay": `${Math.min(i, 10) * 45}ms` } as React.CSSProperties}
                target="_blank"
                rel="noreferrer"
              >
                <span className={styles.rowType} data-type="recovered">
                  Exit
                </span>
                <span className={styles.rowDetail}>
                  <Amount raw={recovery.amount} symbol={recovery.assetSymbol} inline /> to{" "}
                  {shortAddress(recovery.owner)}
                </span>
                <span className={styles.rowTime} suppressHydrationWarning>
                  {recovery.timestamp
                    ? localDate(recovery.timestamp)
                    : `block ${Number(recovery.blockNumber).toLocaleString("en-US")}`}{" "}
                  <span aria-label="opens transaction on Blockscout in a new tab">↗</span>
                </span>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className={`container ${styles.panel}`} aria-labelledby="provenance">
        <header className={styles.panelHead}>
          <span className="eyebrow">Provenance</span>
          <h2 id="provenance">Where this address came from.</h2>
          <p>
            This capsule is only on the site because the canonical factory&apos;s own ZapCreated log names it.
            An identically-shaped contract deployed by anything else would never reach this page.
          </p>
        </header>
        <dl className={styles.factGrid}>
          <Fact label="Created in block">
            <span>{Number(provenance.createdBlock).toLocaleString("en-US")}</span>
            {provenance.createdAt !== null && (
              <span className={styles.factNote} suppressHydrationWarning>
                {localDate(provenance.createdAt)}
              </span>
            )}
          </Fact>
          <Fact label="Creation transaction">
            <a href={explorerTransaction(provenance.createdTx)} target="_blank" rel="noreferrer">
              {shortHex(provenance.createdTx)} ↗
            </a>
            <CopyButton className={styles.hexCopy} value={provenance.createdTx} label="Copy hash" />
          </Fact>
          <Fact label="Owner at creation">
            <AddressValue address={provenance.owner} />
          </Fact>
          <Fact label="CREATE2 salt">
            <CopyButton className={styles.hexCopy} value={provenance.salt} label={shortHex(provenance.salt)} />
          </Fact>
          <Fact label="Implementation codehash">
            <CopyButton
              className={styles.hexCopy}
              value={provenance.implCodeHash}
              label={shortHex(provenance.implCodeHash)}
            />
          </Fact>
          <Fact label="Factory implementation">
            <AddressValue address={data.factory.implementation} />
            <span className={styles.factNote}>Factory version {data.factory.version}</span>
          </Fact>
        </dl>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ chain */

type PolicyNode = {
  key: string;
  kind: "source" | "action" | "sink";
  glyph: string;
  title: string;
  detail: string;
  accent: FlowShape;
  /** Shape flowing into this node; null when the snapshot cannot name it. */
  incoming: FlowShape | null;
  link: Address | null;
};

/**
 * The deployed policy as a lego chain.
 *
 * Every string here is derived from a field the contract actually exposes —
 * there is no template to fall back on, so a zap with no step draws no chain
 * rather than a plausible-looking one.
 */
function policyChain(policy: ZapPolicyView): PolicyNode[] | null {
  const step = policy.step;
  if (!step) return null;

  const input = policy.inputSymbol ?? shortAddress(step.tokenIn);
  const output = policy.outputSymbol;
  const amount = formatAmount(step.amountIn, policy.inputSymbol ?? "");
  // Without a known symbol the figure is an undivided integer, and a bare
  // "100,000,000,000,000,000,000" next to a token address invites the reader to
  // treat it as a human amount. Say which it is.
  const amountText = amount.rawUnits ? `${amount.text} raw units of` : amount.text;

  return [
    {
      key: "source",
      kind: "source",
      glyph: "wallet",
      title: "Bound input",
      detail: `${amountText} ${input} — the exact amount the policy hash commits to.`,
      accent: "token",
      incoming: null,
      link: step.tokenIn,
    },
    {
      key: "swap",
      kind: "action",
      glyph: "swap",
      title: "Swap",
      detail: output
        ? `${input} → ${output} through the allowlisted adapter, with ${step.data === "0x" ? "no adapter calldata" : "adapter calldata attached"}.`
        : `${input} into an output this snapshot cannot name — the input asset is outside the live route.`,
      accent: "token",
      incoming: "token",
      link: step.adapter,
    },
    {
      key: "settle",
      kind: "sink",
      glyph: "send",
      title: "Settle",
      detail: output
        ? `${output} to ${shortAddress(policy.recipient)}.`
        : `Proceeds to ${shortAddress(policy.recipient)}.`,
      accent: "token",
      // Without a resolved direction the output asset is genuinely unknown, so
      // this connector is drawn unresolved rather than assumed to be an ERC-20.
      incoming: output ? "token" : null,
      link: policy.recipient,
    },
  ];
}

/* -------------------------------------------------------------- fragments */

function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AddressValue({ address }: { address: Address }): React.JSX.Element {
  return (
    <>
      <a href={explorerAddress(address)} target="_blank" rel="noreferrer">
        {shortAddress(address)} ↗
      </a>
      <CopyButton className={styles.hexCopy} value={address} label="Copy" />
    </>
  );
}

function Metric({
  label,
  value,
  srValue,
  hydrationSafe = false,
}: {
  label: string;
  value: string;
  /** Spoken text when the visible value is a placeholder like "—". */
  srValue?: string;
  /** Locale-formatted dates differ between the server's zone and the visitor's. */
  hydrationSafe?: boolean;
}): React.JSX.Element {
  return (
    <div className={styles.metric}>
      <strong aria-label={srValue ? `${label}: ${srValue}` : undefined} suppressHydrationWarning={hydrationSafe}>
        {value}
      </strong>
      <span>{label}</span>
    </div>
  );
}

/**
 * "No execution has ever happened" and "the execution happened but its block
 * timestamp could not be read" are different facts, and a null timestamp means
 * both. Collapsing them into "None yet" would tell a visitor this zap never ran
 * whenever one getBlock call failed.
 */
function ExecutionTime({
  count,
  label,
  timestamp,
}: {
  count: number;
  label: string;
  timestamp: number | null;
}): React.JSX.Element {
  if (count === 0) return <Metric label={label} value="None yet" />;
  if (timestamp === null) return <Metric label={label} value="—" srValue="timestamp unavailable" />;
  return <Metric hydrationSafe label={label} value={localDate(timestamp)} />;
}

function Amount({
  raw,
  symbol,
  inline = false,
}: {
  raw: string;
  symbol: string;
  inline?: boolean;
}): React.JSX.Element {
  const formatted = formatAmount(raw, symbol);
  const text = `${formatted.text} ${symbol}`.trim();
  if (inline) {
    return <span title={formatted.exact}>{text}</span>;
  }
  return (
    <strong className={styles.amount} title={formatted.exact}>
      {text}
      {formatted.rawUnits && <em> (raw units — this token&apos;s decimals were not read)</em>}
    </strong>
  );
}

/* ---------------------------------------------------------------- helpers */

/**
 * Assets whose 18 decimals this app knows first-hand. Anything else keeps its
 * raw integer: dividing by an assumed 1e18 would print a number that is simply
 * wrong for a 6-decimal token, and a wrong number is worse than an ugly one.
 */
const EIGHTEEN_DECIMALS = new Set(["aeWETH", "0xZAPS", "ETH"]);

function formatAmount(raw: string, symbol: string): { text: string; exact: string; rawUnits: boolean } {
  const value = BigInt(raw);
  if (!EIGHTEEN_DECIMALS.has(symbol)) {
    return { text: group(value.toString()), exact: raw, rawUnits: value !== 0n };
  }
  const exact = formatUnits(value, 18);
  if (value > 0n && value < 10n ** 12n) return { text: "<0.000001", exact, rawUnits: false };
  const [whole, fraction = ""] = exact.split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/, "");
  return { text: `${group(whole)}${trimmed ? `.${trimmed}` : ""}`, exact, rawUnits: false };
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function totalsByAsset(rows: readonly { assetSymbol: string; amount: string }[]): [string, string][] {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    totals.set(row.assetSymbol, (totals.get(row.assetSymbol) ?? 0n) + BigInt(row.amount));
  }
  return [...totals].map(([symbol, total]) => [symbol, total.toString()]);
}

function localDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortHex(hex: string): string {
  return `${hex.slice(0, 10)}…${hex.slice(-8)}`;
}

function shortDigits(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}
