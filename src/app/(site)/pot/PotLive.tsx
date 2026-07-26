"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, type Address } from "viem";

import { BlockGlyph } from "@/app/(site)/zap/BlockGlyph";
import { resolveRouteById } from "@/lib/routes";
import { CopyButton } from "@/components/CopyButton";
import { useWalletSession } from "@/components/WalletProvider";
import {
  ROBINHOOD_RPC_URL,
  ensureRobinhoodChain,
  explorerAddress,
  explorerTransaction,
  getInjectedProvider,
  robinhoodChain,
  v4QuoterAbi,
  ROBINHOOD_LIQUIDITY,
  ROBINHOOD_ASSETS,
} from "@/lib/robinhood";
import {
  conversionFloor,
  formatPotAmount,
  isConvertible,
  lifetimeAwarded,
  lifetimeZapsBought,
  potAbi,
  ticketShare,
  type PotSnapshot,
} from "@/lib/pot";
import styles from "./pot.module.css";

export interface PotPayload {
  pots: PotSnapshot[];
  headBlock: string;
  readAt: string;
}

type State =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; data: PotPayload; staleSince: string | null };

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

/** Slippage band on a permissionless conversion. Matches the keeper's default. */
const CONVERT_SLIPPAGE_BPS = 100;

/** Fee asset -> the registry route that prices it into 0xZAPS, for the conversion floor. */
const ROUTE_TO_ZAPS: Record<string, string> = {
  [ROBINHOOD_ASSETS.weth.toLowerCase()]: "robinhood-v4-weth-zaps",
};

export function PotLive({ initial }: { initial: PotPayload | null }): React.JSX.Element {
  const {
    account,
    isRobinhoodChain,
    connect: connectSession,
    switchToRobinhood,
  } = useWalletSession();
  const [state, setState] = useState<State>(
    initial ? { status: "ready", data: initial, staleSince: null } : { status: "loading" },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const seq = useRef(0);

  const load = useCallback(async (viewer: Address | null): Promise<void> => {
    const mine = ++seq.current;
    try {
      const query = viewer ? `?viewer=${viewer}` : "";
      const response = await fetch(`/api/protocol/pot${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as PotPayload;
      if (mine !== seq.current) return; // a late response must never overwrite fresher data
      setState({ status: "ready", data, staleSince: null });
    } catch {
      if (mine !== seq.current) return;
      setState((current) =>
        current.status === "ready"
          ? { ...current, staleSince: current.staleSince ?? new Date().toISOString() }
          : { status: "unavailable" },
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load(account);
    });
    const timer = window.setInterval(() => void load(account), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [load, account]);

  const connect = useCallback(async () => {
    setBusy("connect");
    setError("");
    try {
      const address = await connectSession();
      await load(address);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect.");
    } finally {
      setBusy(null);
    }
  }, [connectSession, load]);

  const switchWalletNetwork = useCallback(async (): Promise<void> => {
    setBusy("connect");
    setError("");
    try {
      await switchToRobinhood();
      setNotice("Wallet switched to Robinhood Chain.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not switch network.");
    } finally {
      setBusy(null);
    }
  }, [switchToRobinhood]);

  /**
   * Push a pending fee asset into the prize. `buyZaps` is permissionless by design —
   * the keeper daemon calls it on a cadence, but anyone may, and doing it from here
   * is what lets a holder close the loop themselves rather than wait for a daemon.
   * The floor is quoted first: passing 0 would accept any output at all.
   */
  const convert = useCallback(
    async (pot: PotSnapshot, asset: Address, amount: bigint, symbol: string) => {
      setBusy(`convert:${pot.address}:${asset}`);
      setError("");
      setNotice("");
      try {
        if (!account) throw new Error("Connect a wallet first.");
        const provider = getInjectedProvider();
        if (!provider) throw new Error("No injected wallet found in this browser.");
        await ensureRobinhoodChain(provider);

        // Quote through the app's own registry so the transaction carries a real
        // minimum-out. The pot's BUY_ADAPTER is pinned in the contract, so the path
        // is not ours to choose — we only need a floor. A single-pool route is the
        // only shape quotable here; anything else is left to simulateContract, which
        // reverts with the pot's own error before the user is asked to sign.
        const route = ROUTE_TO_ZAPS[asset.toLowerCase()];
        const quotable = route ? resolveRouteById(route) : null;
        let floor = 0n;
        if (quotable && quotable.quote.source === "v4") {
          const quote = await publicClient.readContract({
            address: ROBINHOOD_LIQUIDITY.v4Quoter,
            abi: v4QuoterAbi,
            functionName: "quoteExactInputSingle",
            args: [{ poolKey: quotable.quote.poolKey, zeroForOne: quotable.quote.zeroForOne, exactAmount: amount, hookData: "0x" }],
          });
          floor = conversionFloor(quote[0], CONVERT_SLIPPAGE_BPS);
        }
        if (floor <= 0n) {
          throw new Error(
            "No single-pool quote is available for this asset, so a safe minimum output cannot be set here. The executor keeper converts it on its own cadence.",
          );
        }

        const wallet = createWalletClient({ account, chain: robinhoodChain, transport: custom(provider) });
        const { request } = await publicClient.simulateContract({
          account,
          address: pot.address,
          abi: potAbi,
          functionName: "buyZaps",
          args: [asset, amount, floor],
        });
        const hash = await wallet.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("The conversion reverted — nothing was converted.");
        setNotice(`Converted ${symbol} into the ${pot.label} prize. Anyone can do this; you just did.`);
        await load(account);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The conversion failed.");
      } finally {
        setBusy(null);
      }
    },
    [account, load],
  );

  if (state.status === "loading") {
    return (
      <section className={`container ${styles.panel}`} aria-label="Lottery pot">
        <p className={styles.empty}>Reading both pots from Robinhood Chain…</p>
      </section>
    );
  }

  if (state.status === "unavailable") {
    return (
      <section className={`container ${styles.panel}`} aria-label="Lottery pot">
        <div className={styles.alert} role="alert">
          <BlockGlyph name="alert" className={styles.alertGlyph} />
          <p>
            The RPC reads for the pot failed, so nothing is shown. A prize or a ticket count rendered
            from a failed read would be a claim about the chain that nobody verified.
          </p>
        </div>
      </section>
    );
  }

  const { data, staleSince } = state;

  return (
    <>
      <section className={`container ${styles.walletBar}`} aria-label="Wallet">
        {account ? (
          <>
            <p className={styles.connected}>
              <BlockGlyph name={isRobinhoodChain ? "check" : "alert"} className={styles.barGlyph} />
              Reading tickets for <code>{short(account)}</code>
            </p>
            {!isRobinhoodChain ? (
              <button className="btn btnGhost" data-busy={busy === "connect"} disabled={busy !== null} onClick={() => void switchWalletNetwork()} type="button">
                {busy === "connect" ? "Switching…" : "Switch network"}
              </button>
            ) : null}
          </>
        ) : (
          <>
            <p className={styles.connectHint}>Connect to see your tickets and to convert fees into the prize.</p>
            <button className="btn btnGhost" data-busy={busy === "connect"} disabled={busy !== null} onClick={() => void connect()} type="button">
              {busy === "connect" ? "Connecting…" : "Connect wallet"}
            </button>
          </>
        )}
      </section>

      <div aria-live="polite" className="container">
        {notice && (
          <p className={styles.notice}>
            <BlockGlyph name="check" className={styles.barGlyph} />
            {notice}
          </p>
        )}
        {error && (
          <p className={styles.alert} role="alert">
            <BlockGlyph name="alert" className={styles.alertGlyph} />
            {error}
          </p>
        )}
        {staleSince && (
          <p className={styles.stale}>
            Refresh has been failing since {new Date(staleSince).toLocaleTimeString("en-US")} — the figures below are
            the last verified snapshot.
          </p>
        )}
      </div>

      {data.pots.map((pot) => {
        const share = ticketShare(pot.yourTickets, pot.totalTickets);
        const held = pot.pending.filter((entry) => BigInt(entry.balance) > 0n);
        const convertible = held.filter((entry) => isConvertible(entry.asset));
        const stranded = held.filter((entry) => !isConvertible(entry.asset));
        const historyVerified = pot.historyStatus === "verified";
        const converted = historyVerified ? lifetimeZapsBought(pot.conversions) : null;
        const awarded = historyVerified ? lifetimeAwarded(pot.awards) : null;
        const empty = BigInt(pot.prize) === 0n && BigInt(pot.totalTickets) === 0n;

        return (
          <section className={`container ${styles.pot}`} key={pot.address} aria-label={`${pot.label} lottery pot`}>
            <header className={styles.potHead}>
              <div>
                <span className="eyebrow">{pot.label} pot · round {pot.round}</span>
                <h2>
                  {empty ? "Nothing in this pot yet." : `${formatPotAmount(pot.prize)} 0xZAPS in the prize.`}
                </h2>
              </div>
              <a className={styles.potAddr} href={explorerAddress(pot.address)} target="_blank" rel="noreferrer">
                {short(pot.address)} ↗
              </a>
            </header>

            <dl className={styles.stats}>
              <div>
                <dt>Prize this round</dt>
                <dd>
                  <strong>{formatPotAmount(pot.prize)}</strong> 0xZAPS
                </dd>
              </div>
              <div>
                <dt>Your share of this round</dt>
                <dd>
                  {/* A share, never a ticket count beside a 0xZAPS figure: tickets are raw
                      fee units summed across assets of different decimals, so rendering
                      them at the prize asset's scale would invite "1 ticket = 1 0xZAPS". */}
                  <strong>{share === null ? "—" : `${(share * 100).toFixed(2)}%`}</strong>
                  <span className={styles.sub}>
                    {share === null ? "connect a wallet to read your tickets" : "of the fees this round collected"}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Converted to 0xZAPS</dt>
                <dd>
                  <strong>{converted === null ? "—" : formatPotAmount(converted.toString())}</strong>
                  <span className={styles.sub}>{historyVerified ? "lifetime" : "history RPC unavailable"}</span>
                </dd>
              </div>
              <div>
                <dt>Paid to winners</dt>
                <dd>
                  <strong>{awarded === null ? "—" : formatPotAmount(awarded.toString())}</strong>
                  <span className={styles.sub}>{historyVerified ? "lifetime" : "history RPC unavailable"}</span>
                </dd>
              </div>
            </dl>

            {!historyVerified && (
              <p className={styles.stale} role="status">
                Prize, ticket, and held-asset reads above are verified at block {Number(data.headBlock).toLocaleString("en-US")}.{" "}
                Conversion and winner history is hidden because its full RPC log scan did not verify.
              </p>
            )}

            {/* The open half of the loop. A fee that arrives as aeWETH or USDG is not
                prize yet — someone has to convert it, and anyone may. */}
            <div className={styles.convert}>
              <h3>
                <BlockGlyph name="repeat" className={styles.sectionGlyph} />
                Fees awaiting conversion
              </h3>
              {convertible.length > 0 ? (
                <ul className={styles.pendingList}>
                  {convertible.map((entry) => (
                    <li key={entry.asset}>
                      <span className={styles.pendingAmount}>
                        {formatPotAmount(entry.balance, entry.decimals)} {entry.symbol}
                      </span>
                      <button
                        className="btn btnPrimary"
                        data-busy={busy === `convert:${pot.address}:${entry.asset}`}
                        disabled={busy !== null || !account || !isRobinhoodChain}
                        onClick={() => void convert(pot, entry.asset, BigInt(entry.balance), entry.symbol)}
                        type="button"
                        title={!account ? "Connect a wallet to submit the conversion" : !isRobinhoodChain ? "Switch to Robinhood Chain to submit the conversion" : undefined}
                      >
                        <BlockGlyph name="bolt" className={styles.btnGlyph} />
                        {busy === `convert:${pot.address}:${entry.asset}` ? "Zapping fees…" : "Zap fees into 0xZAPS"}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.muted}>
                  Nothing convertible is sitting here. This pot&apos;s prize is whatever arrived as 0xZAPS directly,
                  plus anything already converted.
                </p>
              )}

              {stranded.length > 0 && (
                <div className={styles.stranded}>
                  <p>
                    <BlockGlyph name="alert" className={styles.alertGlyph} />
                    Held but <strong>not convertible</strong>, and not part of any prize:
                  </p>
                  <ul>
                    {stranded.map((entry) => (
                      <li key={entry.asset}>
                        {formatPotAmount(entry.balance, entry.decimals)} {entry.symbol}
                      </li>
                    ))}
                  </ul>
                  <p className={styles.strandedWhy}>
                    The pot&apos;s buy adapter is immutable and only accepts aeWETH, <code>awardRound</code> pays only
                    0xZAPS, and there is no owner drain — so a fee that arrives in one of these assets stays where it
                    is permanently. Nothing here will convert it later.
                  </p>
                </div>
              )}

              <p className={styles.convertNote}>
                <code>buyZaps</code> is permissionless — any wallet can call it, and the output is measured by the
                pot&apos;s own balance delta rather than trusted from the adapter. Only aeWETH can be converted: the
                adapter the pot is welded to takes nothing else.
              </p>
            </div>

            {historyVerified && pot.conversions.length > 0 && (
              <div className={styles.history}>
                <h3>Conversions</h3>
                <div className={styles.scroller}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Round</th>
                        <th scope="col">Spent</th>
                        <th scope="col">Bought</th>
                        <th scope="col">By</th>
                        <th scope="col">Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pot.conversions.map((entry) => (
                        <tr key={`${entry.txHash}-${entry.blockNumber}`}>
                          <td>{entry.round}</td>
                          <td>{formatPotAmount(entry.amountIn)} {entry.symbolIn}</td>
                          <td className={styles.gain}>{formatPotAmount(entry.zapsOut)} 0xZAPS</td>
                          <td>{short(entry.caller)}</td>
                          <td>
                            <a href={explorerTransaction(entry.txHash)} target="_blank" rel="noreferrer">
                              {short(entry.txHash)} ↗
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {historyVerified && pot.awards.length > 0 && (
              <div className={styles.history}>
                <h3>Winners</h3>
                <div className={styles.scroller}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Round</th>
                        <th scope="col">Winner</th>
                        <th scope="col">Prize</th>
                        <th scope="col">Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pot.awards.map((entry) => (
                        <tr key={`${entry.txHash}-${entry.round}`}>
                          <td>{entry.round}</td>
                          <td>
                            <CopyButton className={styles.copy} value={entry.winner} label={short(entry.winner)} />
                          </td>
                          <td className={styles.gain}>{formatPotAmount(entry.prize)} 0xZAPS</td>
                          <td>
                            <a href={explorerTransaction(entry.txHash)} target="_blank" rel="noreferrer">
                              {short(entry.txHash)} ↗
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        );
      })}

      <section className={`container ${styles.rules}`} aria-label="How the pot works">
        <h2>What is settled, and what is not.</h2>
        <div className={styles.ruleGrid}>
          <article>
            <h3>Where the prize comes from</h3>
            <p>
              Every automated run pays 1% of its output: 80% to the executor that submitted it, 20% here. When a run
              settles in 0xZAPS the pot is credited directly; in any other asset it waits for a conversion.
            </p>
          </article>
          <article>
            <h3>What a ticket is</h3>
            <p>
              The raw fee amount your zap contributed, credited to the round. Counts are summed across assets of
              different decimals, so a share is contribution <em>weight</em> — not odds, and not a probability.
              Tickets are keyed per round: once a round is awarded they confer nothing, and you have to contribute
              again to be eligible in the next one.
            </p>
          </article>
          <article>
            <h3>What can be paid out</h3>
            <p>
              Only 0xZAPS, only a round&apos;s accrued prize, and only to an address holding tickets in that round.
              A round with no prize or no participants cannot be closed at all.
            </p>
          </article>
          <article>
            <h3>What is still deferred</h3>
            <p>
              How a winner gets chosen. Until that decision lands, <code>awardRound</code> is governance-gated — so
              there is no draw schedule here, no countdown, and the pot has no owner drain.
            </p>
          </article>
        </div>
        <p className={styles.foot}>
          Live state read at block {Number(data.headBlock).toLocaleString("en-US")}. Prize, tickets, and held assets are
          block-pinned contract reads; lifetime figures appear only after the pot&apos;s emitted events verify through that
          block. Verify any of it on{" "}
          <Link href="/explore">Explore</Link> or straight from the explorer links above.
        </p>
      </section>
    </>
  );
}

function short(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}
