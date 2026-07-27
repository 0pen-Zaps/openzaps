import { formatUnits } from "viem";

import { BlockGlyph } from "@/app/(site)/zap/BlockGlyph";
import type {
  WalletPortfolioHolding,
  WalletPortfolioPayload,
} from "@/lib/profile-portfolio";
import { explorerAddress } from "@/lib/robinhood";
import styles from "./portfolio-panel.module.css";

export type PortfolioPanelStatus = "idle" | "loading" | "ready" | "unavailable";

interface PortfolioPanelProps {
  status: PortfolioPanelStatus;
  data: WalletPortfolioPayload | null;
  error: string | null;
  onRetry: () => void;
}

/**
 * Slice tones, as tokens rather than literals. The six hexes these replace were
 * Voltage-era neons: garish on Ivory and Paper, and near-invisible on the dark
 * themes they were not tuned for. Every consumer takes a raw string — the SVG
 * `stroke`, the legend swatch background, and the `--asset-color` custom
 * property — so `var(--token)` works in all three without further change.
 */
const SLICE_COLORS = ["var(--zap)", "var(--ok)", "var(--info)", "var(--warn)", "var(--zap-deep)", "var(--link)"] as const;

export function PortfolioPanel({ status, data, error, onRetry }: PortfolioPanelProps): React.JSX.Element {
  if ((status === "idle" || status === "loading") && !data) {
    return (
      <section className={styles.panel} aria-busy="true" aria-label="Wallet holdings">
        <header className={styles.head}>
          <h2>Holdings</h2>
          <span className={styles.hint}>reading balances and onchain quotes</span>
          <div className={styles.headMeta}>
            <span className={styles.reading}>RPC snapshot</span>
          </div>
        </header>
        <div className={styles.skeleton} aria-hidden>
          <i />
          <i />
          <i />
        </div>
      </section>
    );
  }

  if (status === "unavailable" || !data) {
    return (
      <section className={styles.panel} aria-label="Wallet holdings">
        <div className={styles.unavailable} role="alert">
          <BlockGlyph name="alert" />
          <div>
            <h2>Holdings unavailable</h2>
            <p className={styles.hint}>no zero portfolio was inferred</p>
            <p>{error ?? "The Robinhood Chain RPC balance snapshot failed."}</p>
          </div>
          <button className={styles.panelBtn} onClick={onRetry} type="button">Retry holdings</button>
        </div>
      </section>
    );
  }

  const visible = data.holdings.filter((holding) => holding.balance === null || BigInt(holding.balance) > 0n);
  const priced = visible.filter((holding) => holding.valuationStatus === "priced" && holding.valueEth !== null);
  const subtotal = formatAmount(data.pricedSubtotalEth, 18, 6);
  const complete = data.valuationStatus === "complete";
  const empty = data.valuationStatus === "empty";

  return (
    <section className={styles.panel} aria-labelledby="portfolio-heading">
      <header className={styles.head}>
        <h2 id="portfolio-heading">Holdings</h2>
        <span className={styles.hint}>read straight from this wallet</span>
        <div className={styles.headMeta}>
          <span data-status={data.valuationStatus}>{valuationLabel(data.valuationStatus)}</span>
          <button className={styles.panelBtn} data-busy={status === "loading"} disabled={status === "loading"} onClick={onRetry} type="button">
            {status === "loading" ? "Refreshing…" : "Refresh holdings"}
          </button>
        </div>
        <p>Curated Robinhood Chain balances. Onchain route quotes price only assets with a defensible ETH path.</p>
      </header>

      {empty ? (
        <div className={styles.empty}>
          <BlockGlyph name="wallet" />
          <div>
            <h3>No tracked balance found at block {Number(data.headBlock).toLocaleString("en-US")}.</h3>
            <p>All {data.trackedAssetCount} curated balance reads succeeded. Untracked tokens, NFTs, other chains, and protocol positions are outside this result.</p>
          </div>
        </div>
      ) : (
        <div className={styles.summaryGrid}>
          <div className={styles.valueCard}>
            <span>Priced ETH subtotal</span>
            <strong>{subtotal} ETH</strong>
            <p>
              {complete
                ? `All ${data.nonzeroHoldingCount} nonzero tracked balances are priced.`
                : `${data.pricedHoldingCount} priced · ${data.unpricedHoldingCount} unpriced · ${data.readFailureCount} unreadable.`}
            </p>
            <em>Not total net worth</em>
          </div>
          <PortfolioDonut holdings={priced} subtotal={BigInt(data.pricedSubtotalEth)} />
        </div>
      )}

      {!empty ? (
        <div className={styles.holdings}>
          <div className={styles.tableHead} aria-hidden>
            <span>Asset</span>
            <span>Wallet balance</span>
            <span>ETH value / source</span>
          </div>
          {visible.map((holding, index) => (
            <article className={styles.row} key={holding.id}>
              <span className={styles.assetGlyph} style={{ "--asset-color": SLICE_COLORS[index % SLICE_COLORS.length] } as React.CSSProperties}>
                <BlockGlyph name={glyphFor(holding)} />
              </span>
              <div className={styles.assetName}>
                <strong>{holding.symbol}</strong>
                <span>{holding.name}</span>
                {holding.address ? <a href={explorerAddress(holding.address)} target="_blank" rel="noreferrer">{shortAddress(holding.address)} ↗</a> : <code>native gas asset</code>}
              </div>
              <div className={styles.balance}>
                <span>Wallet balance</span>
                <strong>{holding.balance === null ? "Unavailable" : `${formatAmount(holding.balance, holding.decimals, 6)} ${holding.symbol}`}</strong>
              </div>
              <div className={styles.valuation} data-status={holding.valuationStatus}>
                <span>{holding.valuationStatus === "priced" ? "ETH value" : "Valuation"}</span>
                <strong>{holding.valueEth === null ? valuationRowLabel(holding) : `${formatAmount(holding.valueEth, 18, 6)} ETH`}</strong>
                {holding.valuationSourceLabel ? (
                  holding.valuationSourceUrl
                    ? <a href={holding.valuationSourceUrl} target="_blank" rel="noreferrer">{holding.valuationSourceLabel} ↗</a>
                    : <small>{holding.valuationSourceLabel}</small>
                ) : null}
                {holding.valuationCaveat ? <small>{holding.valuationCaveat}</small> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}

      <footer className={styles.provenance}>
        <span data-status={data.sourceStatus}>{data.sourceStatus} · block {Number(data.headBlock).toLocaleString("en-US")}</span>
        <div>
          <strong>{data.sourceLabel}</strong>
          <small>Updated {formatTimestamp(data.updatedAt)}</small>
        </div>
        <p>{data.sourceCaveat}</p>
      </footer>
    </section>
  );
}

function PortfolioDonut({
  holdings,
  subtotal,
}: {
  holdings: WalletPortfolioHolding[];
  subtotal: bigint;
}): React.JSX.Element {
  if (subtotal <= 0n || holdings.length === 0) {
    return (
      <div className={styles.noChart}>
        <BlockGlyph name="gauge" />
        <span>No priced allocation to chart.</span>
      </div>
    );
  }

  const slices = holdings.reduce<Array<{
    holding: WalletPortfolioHolding;
    basisPoints: number;
    offset: number;
    color: string;
  }>>((current, holding, index) => {
    const value = BigInt(holding.valueEth ?? "0");
    const basisPoints = Number((value * 10_000n) / subtotal);
    const previous = current.at(-1);
    const offset = previous ? previous.offset + previous.basisPoints : 0;
    return [...current, { holding, basisPoints, offset, color: SLICE_COLORS[index % SLICE_COLORS.length] }];
  }, []);

  return (
    <figure className={styles.chart}>
      <svg viewBox="0 0 100 100" role="img" aria-label="Priced ETH allocation">
        <circle className={styles.chartTrack} cx="50" cy="50" r="39" pathLength="10000" />
        {slices.map((slice) => (
          <circle
            className={styles.chartSlice}
            cx="50"
            cy="50"
            r="39"
            pathLength="10000"
            key={slice.holding.id}
            stroke={slice.color}
            strokeDasharray={`${slice.basisPoints} ${10_000 - slice.basisPoints}`}
            strokeDashoffset={-slice.offset}
          />
        ))}
        <text x="50" y="47" textAnchor="middle">PRICED</text>
        <text x="50" y="57" textAnchor="middle">ETH</text>
      </svg>
      <figcaption>
        {slices.map((slice) => (
          <div key={slice.holding.id}>
            <i style={{ background: slice.color }} />
            <span>{slice.holding.symbol}</span>
            <strong>{(slice.basisPoints / 100).toFixed(1)}%</strong>
          </div>
        ))}
      </figcaption>
    </figure>
  );
}

function glyphFor(holding: WalletPortfolioHolding): string {
  if (holding.kind === "native") return "wallet";
  if (holding.kind === "vault-share") return "vault";
  if (holding.kind === "lp-share") return "pool";
  return "coins";
}

function valuationLabel(status: WalletPortfolioPayload["valuationStatus"]): string {
  if (status === "complete") return "priced coverage complete";
  if (status === "partial") return "partial · unpriced assets excluded";
  if (status === "empty") return "tracked balances empty";
  return "valuation unavailable";
}

function valuationRowLabel(holding: WalletPortfolioHolding): string {
  if (holding.valuationStatus === "unavailable") return "Source unavailable";
  if (holding.valuationStatus === "not-applicable") return "Zero balance";
  return "Unpriced";
}

function formatAmount(raw: string, decimals: number, precision: number): string {
  const [integerRaw, fractionRaw = ""] = formatUnits(BigInt(raw), decimals).split(".");
  const integer = integerRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = fractionRaw.slice(0, precision).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "time unavailable"
    : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
