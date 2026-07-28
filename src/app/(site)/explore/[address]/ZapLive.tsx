"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, type Address } from "viem";

import { CopyButton } from "@/components/CopyButton";
import { SHAPE_COLOR, SHAPE_LABEL, type FlowShape } from "@/lib/blocks";
import { describeAutomatedRun } from "@/lib/activity";
import { explorerAddress, explorerTransaction } from "@/lib/robinhood";
import type { ZapDetailPayload, ZapExecution, ZapPolicyView } from "@/lib/zap";
import { BlockGlyph } from "@/app/(site)/zap/BlockGlyph";
import { ProtocolStack } from "@/components/ProtocolLogo";
import { protocolsForRouteKind, type ProtocolInfo } from "@/lib/protocols";
import styles from "../explore.module.css";

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
      <section className={styles.card} aria-label="Zap detail">
        <p className={styles.empty}>Reading this Zap&apos;s policy, balances, and logs from Robinhood Chain…</p>
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
      <section className={styles.card} aria-label="Zap detail">
        <div className={styles.unavailable} role="alert">
          <p>
            The Robinhood RPC reads for this address failed, so its onchain state is unavailable. The factory
            check is one of the reads that failed, so not even &ldquo;this is a deployed Zap&rdquo; is
            claimed here. A stale balance or a zeroed execution count would each be a claim about the chain
            that nobody verified. Nothing is shown instead.
          </p>
          <button
            className={styles.ghostBtn}
            onClick={() => {
              setState({ status: "loading" });
              void load();
            }}
            type="button"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const { data, staleSince } = state;
  const { policy, provenance, stats, balances, executions, recoveries } = data;
  const verified = policy.canonicalClone && policy.hashMatches;
  const chain = policyChain(policy);
  // A one-shot's fee is the RELAYER fee, bounded by maxRelayerFeeCap; an
  // automated run's is the protocol fee, which that cap does not govern at all.
  // They are summed separately because the card explains each in its own terms —
  // printing one number would make this page contradict the cap it prints above.
  const relayerFeeTotals = feeTotalsFor(executions, (kind) => kind === "one-shot");
  const protocolFeeTotals = feeTotalsFor(executions, (kind) => kind !== "one-shot");
  const recoveredTotals = totalsByAsset(recoveries);

  return (
    <>
      <section className={styles.card} aria-label="Verification">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Verification</h2>
          <span className={styles.cardSub}>read at one pinned block</span>
          <span className={styles.cardHeadEnd}>
            <span className={styles.stateChip} data-verified={verified}>
              {verified ? "✓ Verified onchain" : "⚠ Unverified shape"}
            </span>
          </span>
        </div>
        <p className={styles.cardBody}>
          {verified
            ? "The factory's own ZapCreated log names this address. Its runtime is the EIP-1167 clone of the canonical implementation. The policy it exposes rehashes to the policyHash it committed to."
            : "The factory created this address, but at least one integrity check does not hold. Every failing check is listed below. Nothing has been rounded off or assumed."}
        </p>
        <dl className={styles.factGrid}>
          <Fact label="Read at block">
            <span>{Number(data.headBlock).toLocaleString("en-US")}</span>
          </Fact>
          <Fact label="Snapshot taken">
            <span suppressHydrationWarning>{new Date(data.readAt).toLocaleString("en-US")}</span>
          </Fact>
          <Fact label="Lifecycle">
            <span>{LIFECYCLE_COPY[data.lifecycle]}</span>
          </Fact>
        </dl>
        <p className={`${styles.cardFoot} ${styles.refreshLine}`}>
          {refreshing && <span aria-hidden className={`spinner ${styles.updatedSpinner}`} />}
          <span>
            Every contract read and log query on this page is pinned to that one block, so the policy, the
            balances, and the event history describe the same moment. Nothing here is estimated or priced.
          </span>
        </p>
      </section>

      <div aria-live="polite">
        {staleSince && (
          <div className={styles.staleWarning}>
            Refresh has been failing since{" "}
            <span suppressHydrationWarning>{new Date(staleSince).toLocaleTimeString("en-US")}</span> — everything
            below is the last verified snapshot, read at block{" "}
            {Number(data.headBlock).toLocaleString("en-US")}.
          </div>
        )}
      </div>

      <section className={styles.card} aria-labelledby="what-this-does">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle} id="what-this-does">
            The deployed chain
          </h2>
          <span className={styles.cardSub}>drawn from this Zap&apos;s own policy fields, not from a template</span>
        </div>

        {policy.deviations.length > 0 && (
          <div className={styles.deviations} role="alert">
            <strong>This Zap departs from the routes the live contracts support.</strong>
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
                    style={
                      {
                        "--shape": node.incoming ? SHAPE_COLOR[node.incoming] : "var(--danger)",
                      } as React.CSSProperties
                    }
                  >
                    <span className={styles.jointLine} />
                    <span className={styles.jointLabel}>
                      {node.incoming ? SHAPE_LABEL[node.incoming] : "unresolved"}
                    </span>
                  </div>
                )}
                <article
                  className={styles.chainCard}
                  data-kind={node.kind}
                  style={{ "--shape": SHAPE_COLOR[node.accent] } as React.CSSProperties}
                >
                  <span className={styles.chainGlyphTile}>
                    <BlockGlyph name={node.glyph} className={styles.glyph} />
                  </span>
                  <div className={styles.chainText}>
                    <strong>
                      {node.title}
                      {node.protocols && node.protocols.length > 0 ? (
                        <>
                          {" "}
                          <ProtocolStack protocols={node.protocols} size={14} />
                        </>
                      ) : null}
                    </strong>
                    <span>{node.detail}</span>
                  </div>
                  {node.link && (
                    <a className={styles.chainLink} href={explorerAddress(node.link)} target="_blank" rel="noreferrer">
                      {shortAddress(node.link)} ↗
                    </a>
                  )}
                </article>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.empty}>
            This Zap exposes no step, so there is no chain to draw. The policy fields it does expose are listed
            below exactly as the contract stores them.
          </p>
        )}

        {policy.stepCount !== "1" && (
          <p className={styles.note}>
            The Zap declares {policy.stepCount} steps. Only step 0 is drawn here. The rest are not guessed at.
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

        <p className={styles.cardFoot}>
          The same block vocabulary the <Link href="/zap">builder</Link> uses. Connectors are coloured by the shape
          of value moving along them.
        </p>
      </section>

      <section className={styles.card} aria-labelledby="what-happened">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle} id="what-happened">
            What has happened
          </h2>
          <span className={styles.cardSub}>measured, not modelled</span>
        </div>

        <div className={styles.metricGrid}>
          <Metric label="Executions" value={String(stats.executionCount)} />
          <Metric label="Of those, automated" value={String(stats.automatedRunCount)} />
          <Metric label="Emergency exits" value={String(stats.recoveryCount)} />
          <ExecutionTime count={stats.executionCount} label="First execution" timestamp={stats.firstExecutionAt} />
          <ExecutionTime count={stats.executionCount} label="Last execution" timestamp={stats.lastExecutionAt} />
        </div>

        <div className={styles.totalsGrid}>
          <div className={styles.totalsCard}>
            <h3>Produced by executions</h3>
            {Object.keys(stats.amountOutByAsset).length === 0 ? (
              <p className={styles.empty}>None yet — this Zap has never emitted an execution log.</p>
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
            <h3>Fee withheld from output</h3>
            {relayerFeeTotals.length === 0 && protocolFeeTotals.length === 0 ? (
              <p className={styles.empty}>
                {policy.maxRelayerFeeCap === "0"
                  ? "Zero, and not because none happened to be taken. This policy commits maxRelayerFeeCap = 0, so no execution of it can pay a relayer fee. The bound comes from the policy hash, not from a measurement."
                  : "No fee appears in any execution log for this Zap."}
              </p>
            ) : (
              <ul className={styles.totalsList}>
                {relayerFeeTotals.map(([symbol, raw]) => (
                  <li key={`relayer-${symbol}`}>
                    <Amount raw={raw} symbol={symbol} />
                    <span className={styles.totalsNote}>
                      relayer fee, summed from the fee field of each Executed log
                    </span>
                  </li>
                ))}
                {protocolFeeTotals.map(([symbol, raw]) => (
                  <li key={`protocol-${symbol}`}>
                    <Amount raw={raw} symbol={symbol} />
                    {/* Not a relayer fee, and maxRelayerFeeCap does not bound it:
                        the automated paths withhold a protocol fee and split it
                        between the executor that submitted the run and the pot. */}
                    <span className={styles.totalsNote}>
                      protocol fee on automated runs — executor share plus lottery pot
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={styles.totalsCard}>
            <h3>Swept by emergency exit</h3>
            {recoveredTotals.length === 0 ? (
              <p className={styles.empty}>None — the owner has never pulled assets back out of this Zap.</p>
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
              Custody balances at block {Number(data.headBlock).toLocaleString("en-US")}. aeWETH, 0xZAPS, and ETH are
              the only balances this snapshot reads, so this is not a full inventory of what the Zap holds.
            </span>
          </div>
        </div>

        <p className={styles.cardFoot}>
          Counts and totals come only from this contract&apos;s own execution logs — Executed for an owner-signed
          run, ExecutedRecurring, ExecutedRecurringRelative and ExecutedTrigger for an automated one — plus its
          EmergencyExit logs. No USD value, token price, PnL, APY, or success rate appears on this page. A reverted
          execution emits no log at all, so a success rate computed from these logs would be unfalsifiable, and
          none is shown.
        </p>
      </section>

      <section className={styles.card} aria-labelledby="event-log">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle} id="event-log">
            Every execution and exit
          </h2>
          <span className={styles.cardSub}>read from this contract&apos;s own logs</span>
        </div>

        <h3 className={styles.rowsHead}>Executions</h3>
        {executions.length === 0 ? (
          <p className={styles.empty}>None yet.</p>
        ) : (
          executions.map((execution, i) => (
            <a
              className={styles.eventRow}
              href={explorerTransaction(execution.txHash)}
              key={`${execution.txHash}:${execution.logIndex}`}
              style={{ "--row-delay": `${Math.min(i, 10) * 45}ms` } as React.CSSProperties}
              target="_blank"
              rel="noreferrer"
            >
              <span
                className={styles.eventGlyph}
                data-type={execution.kind === "one-shot" ? "executed" : "automated"}
              >
                <BlockGlyph name={execution.kind === "one-shot" ? "bolt" : "repeat"} />
              </span>
              <span className={styles.eventBody}>
                <span className={styles.eventKind}>{execution.kind === "one-shot" ? "Executed" : "AutoZap"}</span>
                <strong className={styles.eventTitle}>
                  <Amount raw={execution.amountOut} symbol={execution.assetSymbol} inline /> to{" "}
                  {shortAddress(execution.recipient)}
                  {execution.fee !== "0" && (
                    <>
                      {execution.kind === "one-shot" ? " · fee " : " · protocol fee "}
                      <Amount raw={execution.fee} symbol={execution.assetSymbol} inline />
                    </>
                  )}
                </strong>
                {/* A 78-digit nonce or series id would swallow the row, and half
                    of one is not an id, so the full value stays in the title.
                    An automated row also names its EXECUTOR: the point of these
                    runs is that the owner did not submit them. */}
                {execution.kind === "one-shot" ? (
                  <span className={styles.eventDetail} title={`nonce ${execution.nonce}`}>
                    nonce {shortDigits(execution.nonce)}
                  </span>
                ) : (
                  <span className={styles.eventDetail} title={`series ${execution.nonce}`}>
                    {describeAutomatedRun(execution.kind, execution.run)}
                    {execution.executor && <> · submitted by {shortAddress(execution.executor)}</>}
                  </span>
                )}
              </span>
              <span className={styles.eventEnd}>
                <span className={styles.eventTx}>
                  {shortAddress(execution.txHash)}{" "}
                  <span aria-label="opens transaction on Blockscout in a new tab">↗</span>
                </span>
                <span className={styles.eventTime} suppressHydrationWarning>
                  {execution.timestamp
                    ? localDate(execution.timestamp)
                    : `block ${Number(execution.blockNumber).toLocaleString("en-US")}`}
                </span>
              </span>
            </a>
          ))
        )}

        <h3 className={styles.rowsHead}>Emergency exits</h3>
        {recoveries.length === 0 ? (
          <p className={styles.empty}>None yet.</p>
        ) : (
          recoveries.map((recovery, i) => (
            <a
              className={styles.eventRow}
              href={explorerTransaction(recovery.txHash)}
              key={`${recovery.txHash}:${recovery.logIndex}`}
              style={{ "--row-delay": `${Math.min(i, 10) * 45}ms` } as React.CSSProperties}
              target="_blank"
              rel="noreferrer"
            >
              <span className={styles.eventGlyph} data-type="recovered">
                <BlockGlyph name="key" />
              </span>
              <span className={styles.eventBody}>
                <span className={styles.eventKind}>Exit</span>
                <strong className={styles.eventTitle}>
                  <Amount raw={recovery.amount} symbol={recovery.assetSymbol} inline /> to{" "}
                  {shortAddress(recovery.owner)}
                </strong>
              </span>
              <span className={styles.eventEnd}>
                <span className={styles.eventTx}>
                  {shortAddress(recovery.txHash)}{" "}
                  <span aria-label="opens transaction on Blockscout in a new tab">↗</span>
                </span>
                <span className={styles.eventTime} suppressHydrationWarning>
                  {recovery.timestamp
                    ? localDate(recovery.timestamp)
                    : `block ${Number(recovery.blockNumber).toLocaleString("en-US")}`}
                </span>
              </span>
            </a>
          ))
        )}
      </section>

      <section className={styles.card} aria-labelledby="provenance">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle} id="provenance">
            Where this address came from
          </h2>
          <span className={styles.cardSub}>provenance</span>
        </div>
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
          {/* "Contract type", not "Zap type": the values already carry the
              automated-vs-one-shot distinction, and "Zap type" would read as a
              statement about the execution rather than about the contract. */}
          <Fact label="Contract type">
            <strong>{capsuleLineage(data.factory.version).title}</strong>
            <span className={styles.factNote}>{capsuleLineage(data.factory.version).detail}</span>
          </Fact>
        </dl>

        <p className={styles.cardFoot}>
          This Zap is only on the site because the canonical factory&apos;s own ZapCreated log names it. An
          identically-shaped contract deployed by anything else would never reach this page.
        </p>
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
  /** Marks of the protocols this node's adapter actually calls. */
  protocols?: ProtocolInfo[];
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

  // The action card, by the route KIND the read layer resolved — a stitched
  // route or an LP leg drawn as a generic "Swap" would be a false statement
  // about what the adapter does with the funds.
  const action = actionForRouteKind(policy.routeKind, input, output, step.data === "0x");

  return [
    {
      key: "source",
      kind: "source",
      glyph: policy.routeKind === "lp-withdraw" || policy.routeKind === "vault-redeem" ? "pool" : "wallet",
      title: "Bound input",
      detail: `${amountText} ${input} — the exact amount the policy hash commits to.`,
      accent: policy.routeKind === "lp-withdraw" ? "lp" : "token",
      incoming: null,
      link: step.tokenIn,
    },
    {
      key: "action",
      kind: "action",
      glyph: action.glyph,
      title: action.title,
      detail: action.detail,
      accent: action.accent,
      incoming: policy.routeKind === "lp-withdraw" ? "lp" : "token",
      protocols: policy.routeKind ? protocolsForRouteKind(policy.routeKind) : [],
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
      accent: action.emits ?? "token",
      // Without a resolved output the asset is genuinely unknown, so this
      // connector is drawn unresolved rather than assumed to be an ERC-20.
      incoming: output ? (action.emits ?? "token") : null,
      link: policy.recipient,
    },
  ];
}

/**
 * Title, glyph, accent and copy for the capsule's one action, per deployed
 * route kind. `null` (an unrecognized step) keeps the cautious legacy copy.
 */
function actionForRouteKind(
  routeKind: ZapPolicyView["routeKind"],
  input: string,
  output: string | null,
  emptyData: boolean,
): { title: string; glyph: string; accent: FlowShape; emits: FlowShape | null; detail: string } {
  const calldata = emptyData ? "no adapter calldata" : "adapter calldata attached";
  switch (routeKind) {
    case "swap":
      return {
        title: "Swap",
        glyph: "swap",
        accent: "token",
        emits: "token",
        detail: `${input} → ${output} through the allowlisted adapter, with ${calldata}.`,
      };
    case "swap-route":
      return {
        title: "Stitched swap",
        glyph: "swap",
        accent: "token",
        emits: "token",
        detail: `${input} → ${output} through TWO pools in one signed step — the route adapter sizes each hop from the measured output of the last, with ${calldata}.`,
      };
    case "lp-deposit":
      return {
        title: "Zap in to liquidity",
        glyph: "pool",
        accent: "lp",
        emits: "lp",
        detail: `Half the ${input} swaps in-pool, both legs enter the full-range aeWETH/USDG vault, and ${output} shares mint straight to the Zap.`,
      };
    case "lp-withdraw":
      return {
        title: "Zap out of liquidity",
        glyph: "poolOut",
        accent: "lp",
        emits: "token",
        detail: `${input} shares burn for both pool currencies plus accrued fees; the off-target leg swaps in-pool so the Zap settles in ${output}.`,
      };
    case "vault-deposit":
      return {
        title: "Supply",
        glyph: "vault",
        accent: "receipt",
        emits: "receipt",
        detail: `${input} into the ozUSDG receipt vault for ${output} — a wrapper, it earns nothing.`,
      };
    case "vault-redeem":
      return {
        title: "Redeem",
        glyph: "vault",
        accent: "receipt",
        emits: "token",
        detail: `${input} shares burn back to ${output} from the receipt vault.`,
      };
    default:
      return {
        title: "Swap",
        glyph: "swap",
        accent: "token",
        emits: output ? "token" : null,
        detail: output
          ? `${input} → ${output} through the allowlisted adapter, with ${calldata}.`
          : `${input} into an output this snapshot cannot name — the input asset is outside the live route.`,
      };
  }
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
    <div className={styles.metricCard}>
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

/** Per-asset fee totals for the executions whose kind passes `matches`. */
function feeTotalsFor(
  executions: readonly ZapExecution[],
  matches: (kind: ZapExecution["kind"]) => boolean,
): [string, string][] {
  return totalsByAsset(
    executions.filter((entry) => matches(entry.kind)).map((entry) => ({ assetSymbol: entry.assetSymbol, amount: entry.fee })),
  ).filter(([, raw]) => raw !== "0");
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

/**
 * What KIND of capsule this is, read from the creating factory's own VERSION
 * string rather than guessed from an address list — a v3/v3.1 capsule can hold a
 * standing authorization, and that is the single most useful thing to know about
 * it on this page. Unknown versions fall back to the neutral description.
 */
function capsuleLineage(version: string): { title: string; detail: string } {
  if (version.startsWith("3.1")) {
    return {
      title: "Automated · v3.1",
      detail:
        "Can hold a recurring series whose per-run floor is derived from an allowlisted price source at execution, or a one-shot price trigger. Any eligible executor may submit a run this Zap owes.",
    };
  }
  if (version.startsWith("3")) {
    return {
      title: "Automated · v3",
      detail:
        "Can hold a recurring series or a one-shot price trigger. Any eligible executor may submit a run this Zap owes; the chain refuses every run it does not.",
    };
  }
  return {
    title: "One-shot",
    detail: "Executes its frozen policy once, against an owner-signed intent.",
  };
}
