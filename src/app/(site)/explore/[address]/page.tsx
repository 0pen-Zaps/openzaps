import type { Metadata } from "next";
import Link from "next/link";
import { unstable_cache } from "next/cache";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getAddress, type Address } from "viem";

import { JsonLd } from "@/components/JsonLd";
import { explorerAddress } from "@/lib/robinhood";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { fetchZapDetail } from "@/lib/zap-server";
import { isZapNotFound, type ZapDetailPayload } from "@/lib/zap";
import { ZapLive } from "./ZapLive";
import styles from "../explore.module.css";

type Params = { params: Promise<{ address: string }> };

// A zap's policy is immutable, but its executions, balances, and lifecycle are
// not — 5 minutes keeps the crawlable HTML honest without hammering the RPC,
// and the client polls the API route on top of it. Literal only: Next 16
// rejects an expression here at build time. This is the ceiling for a *verified*
// capsule only; see `capUnverifiedCacheLife` for the two answers that must not
// live anywhere near this long.
export const revalidate = 300;

/** Seconds an unverified answer — a 404, or "reads failed" — may be cached. */
const UNVERIFIED_REVALIDATE_SECONDS = 15;

/**
 * Prerender nothing, cache everything.
 *
 * The empty list is what opts this segment into the incremental cache at all —
 * without it Next renders the route fresh on every single request, and each of
 * those requests is a full ~20-call RPC snapshot. Enumerating the deployed zaps
 * here instead would be worse than useless: generateStaticParams never re-runs
 * during ISR, so a build-time list would be frozen, while `dynamicParams` stays
 * at its default `true` so a zap deployed a minute ago renders on demand and is
 * cached for `revalidate` like any other.
 */
export async function generateStaticParams(): Promise<{ address: string }[]> {
  return [];
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type ZapLoad =
  | { status: "ok"; payload: ZapDetailPayload }
  | { status: "missing" }
  | { status: "unavailable" };

/**
 * One read per request, shared by `generateMetadata` and the page body.
 *
 * Without the shared read the metadata pass and the render pass would each pay
 * for the whole RPC snapshot, and — worse — could disagree about whether the
 * address is a zap at all.
 *
 * Only the provenance failure becomes "missing" and may 404. Every other
 * failure — an RPC timeout above all — becomes "unavailable" and stays at 200,
 * because telling a visitor a real capsule does not exist is the worse of the
 * two mistakes.
 */
const loadZap = cache(async (address: Address): Promise<ZapLoad> => {
  try {
    return { status: "ok", payload: await fetchZapDetail(address) };
  } catch (error) {
    return isZapNotFound(error) ? { status: "missing" } : { status: "unavailable" };
  }
});

/**
 * Cut this render's cache life from the segment's 300s down to 15s.
 *
 * WHY the two unverified answers cannot keep the segment's window:
 *
 * A 404 is a statement about the tip of the chain, and it stops being true the
 * instant someone deploys to that address. /app links straight to a capsule's
 * page the moment `createZap` confirms, so a 404 pinned for 300s — with the
 * segment's near-a-year `stale-while-revalidate` behind it — would strand the
 * deployer on "not found" for a capsule they just watched land. A wrong 404
 * has to be cheap to correct; 15s is roughly 150 Robinhood blocks.
 *
 * The unavailable render is a statement about an RPC that is down *right now*.
 * Held for 300s it would keep telling visitors nothing could be read long after
 * the RPC recovered — while `ZapLive` repolls the API route and fills the same
 * page with a real capsule's data, the chrome contradicting the body.
 *
 * The verified case is the opposite and keeps all 300s: a capsule's policy is
 * immutable and its activity moves slowly.
 *
 * WHY this mechanism: a cached read whose `revalidate` is lower than the
 * segment's lowers the whole render's revalidate to its own — the documented
 * way to "dynamically opt-in to more frequent revalidation ... based on some
 * criteria" (Caching and Revalidating (Previous Model)). Only the unverified
 * branches await it, so only those renders are shortened.
 *
 * `connection()` is the obvious-looking alternative and does not work: under a
 * positive `revalidate` a request-time API is an error, and the route returns
 * 500 (DYNAMIC_SERVER_USAGE) instead of the 404. Measured against this build,
 * not assumed. `use cache` is the successor to `unstable_cache`, but it needs
 * Cache Components enabled app-wide in next.config.ts, which would change how
 * every other route here caches; until that migration this is the primitive the
 * Next 16 guide for this app's caching model documents.
 */
const unverifiedCacheWindow = unstable_cache(async () => true, ["zap-unverified-window"], {
  revalidate: UNVERIFIED_REVALIDATE_SECONDS,
});

async function capUnverifiedCacheLife(): Promise<void> {
  await unverifiedCacheWindow();
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { address } = await params;
  const zap = normalizeAddress(address);
  // Malformed input is a 404 before any RPC call, so a garbage URL costs
  // nothing and returns the right status.
  if (!zap) notFound();

  const loaded = await loadZap(zap);
  if (loaded.status === "missing") {
    await capUnverifiedCacheLife();
    notFound();
  }
  if (loaded.status === "unavailable") {
    // Nothing was read, so nothing is asserted — not even that this address is
    // a capsule. The title says the address, not "Zap <address>".
    await capUnverifiedCacheLife();
    return {
      title: `${shortAddress(zap)} — unverified address`,
      description: "Robinhood Chain could not be read for this address, so nothing about it is reported.",
      robots: { index: false, follow: true },
    };
  }

  const { policy, provenance, stats } = loaded.payload;
  const route =
    policy.matchesLiveRoute && policy.inputSymbol && policy.outputSymbol
      ? `a bounded ${policy.inputSymbol} → ${policy.outputSymbol} swap capsule`
      : "a factory-deployed policy capsule";

  return pageMetadata({
    title: `Zap ${shortAddress(zap)} — deployed policy capsule`,
    description:
      `${shortAddress(zap)} is ${route} deployed by the OpenZaps factory on Robinhood Chain, owned by ` +
      `${shortAddress(provenance.owner)} and created in block ${Number(provenance.createdBlock).toLocaleString("en-US")}. ` +
      `${stats.executionCount === 1 ? "1 execution" : `${stats.executionCount} executions`} read from its own onchain logs.`,
    path: `/explore/${zap}`,
    keywords: [
      "OpenZaps zap",
      "policy capsule onchain",
      "Robinhood Chain zap",
      "verified zap policy",
      zap,
    ],
  });
}

export default async function ZapDetailPage({ params }: Params): Promise<React.JSX.Element> {
  const { address } = await params;
  const zap = normalizeAddress(address);
  if (!zap) notFound();

  const loaded = await loadZap(zap);
  if (loaded.status === "missing") {
    await capUnverifiedCacheLife();
    notFound();
  }

  // The provenance gate is the only thing that makes this address a capsule.
  // When the reads failed, that gate never ran, so every line of chrome below
  // has to stop short of saying it did.
  const verified = loaded.status === "ok";
  if (!verified) await capUnverifiedCacheLife();

  return (
    <main className={styles.page} id="main">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          ...breadcrumbJsonLd(`/explore/${zap}`, verified ? `Zap ${shortAddress(zap)}` : shortAddress(zap)),
        }}
      />

      <section className={`container ${styles.detailHero}`}>
        <div>
          <span className="eyebrow">
            <Link className={styles.crumb} href="/explore">
              Deployed zaps
            </Link>
            {verified ? null : <> · unverified address</>}
          </span>
          <h1>
            <span className={styles.heroAddress}>{zap}</span>
          </h1>
          {verified ? (
            <p>
              Everything below was read from Robinhood Chain at one pinned block. This page reports what the
              contract stores and what its own logs say. Nothing is estimated, modelled, or priced. A read
              that fails is reported as unavailable, never as a zero.
            </p>
          ) : (
            <p>
              The reads against Robinhood Chain failed for this address, so nothing about it is claimed here.
              This page is not saying it is a deployed capsule, that it holds anything, or that it has ever
              run — only that the reads failed. Blockscout reads the same chain independently.
            </p>
          )}
          <div className={styles.heroActions}>
            <a className="btn btnGhost" href={explorerAddress(zap)} target="_blank" rel="noreferrer">
              <span>View on Blockscout ↗</span>
            </a>
            <Link className="btn btnGhost" href="/zap">
              <span>Design a chain</span>
            </Link>
          </div>
        </div>
      </section>

      <ZapLive address={zap} initial={loaded.status === "ok" ? loaded.payload : null} />
    </main>
  );
}

/**
 * Every spelling of one address renders the same page — no redirect, no
 * checksum rejection.
 *
 * This is a cache-correctness requirement, not a style choice. A cached
 * segment is keyed by the URL, and casing is the one part of an address URL
 * that varies freely, so any cache that folds case (a case-insensitive
 * filesystem, which is what `next start` uses on macOS) maps every spelling of
 * one zap to a single entry. If the spellings produced *different* responses,
 * whichever arrived first would be served for all of them: a cached 308 turns
 * the canonical URL into a redirect to itself, and a cached 404 tells a visitor
 * a real capsule does not exist. Both were reproducible before this change.
 * Rendering identical HTML for every spelling makes a shared entry harmless and
 * the route's correctness independent of the cache's case sensitivity.
 *
 * Dropping the EIP-55 check costs nothing in error detection: a mistyped hex
 * digit resolves to some other address, and `fetchZapDetail`'s provenance gate
 * 404s anything the factory did not create. One canonical URL per zap is still
 * enforced, by `alternates.canonical` in the metadata rather than by a status
 * code.
 */
function normalizeAddress(raw: string): Address | null {
  if (!HEX_ADDRESS.test(raw)) return null;
  return getAddress(raw.toLowerCase());
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
