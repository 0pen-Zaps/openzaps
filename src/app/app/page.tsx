"use client";

import { useMemo, useState } from "react";
import { OpenZapMark } from "@/components/OpenZapMark";
import { CHAIN, TOKEN, isLive } from "@/lib/config";
import styles from "./app.module.css";

const TOKENS = ["USDC", "WETH", "cbBTC", "DAI"] as const;
const MODELS = [
  { id: "deposit", label: "Deposit", hint: "Pre-fund an immutable zap" },
  { id: "intent", label: "Signed intent", hint: "One-shot EIP-712 authority" },
] as const;

type Zap = { id: string; route: string; amount: string; model: string };

// Deterministic FNV-1a — a stand-in for the on-chain policy hash, SSR-safe (no Date/random).
function policyHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `0x${hex}${hex.split("").reverse().join("")}…`;
}

export default function AppPage(): React.JSX.Element {
  const live = isLive();
  const [model, setModel] = useState<string>("deposit");
  const [tokenIn, setTokenIn] = useState<string>("USDC");
  const [tokenOut, setTokenOut] = useState<string>("WETH");
  const [amount, setAmount] = useState<string>("1000");
  const [slippage, setSlippage] = useState<string>("0.5");
  const [demo, setDemo] = useState<boolean>(false);
  const [zaps, setZaps] = useState<Zap[]>([]);

  const address = demo ? "0xZAP…7e3a" : "";
  const route = `${tokenIn} → ${tokenOut}`;

  const intent = useMemo(() => {
    const recipient = address || "<your wallet>";
    const body = {
      model,
      chainId: CHAIN.id,
      recipient,
      route: `${route} · Uniswap v3`,
      amountIn: `${amount || "0"} ${tokenIn}`,
      minOut: `quote − ${slippage || "0"}%`,
      maxRelayerFee: "0.10%",
      deadline: "+30m",
      optimization: true,
    };
    return { ...body, policyHash: policyHash(JSON.stringify(body)) };
  }, [model, tokenIn, amount, slippage, address, route]);

  const sameToken = tokenIn === tokenOut;

  function createZap(): void {
    if (sameToken) return;
    setZaps((z) => [
      { id: intent.policyHash, route, amount: `${amount} ${tokenIn}`, model },
      ...z.filter((x) => x.id !== intent.policyHash),
    ]);
  }

  return (
    <main className={styles.page} id="main">
      {!live && (
        <div className={`container ${styles.banner}`}>
          <span className="badge">Preview</span>
          <p>
            The builder is fully explorable now. Wallet connect and on-chain deploys go live with the launch
            deployment on {CHAIN.name}.
          </p>
        </div>
      )}

      {/* app header */}
      <section className={`container ${styles.appHead}`}>
        <div className={styles.titleRow}>
          <OpenZapMark className={styles.headMark} />
          <div>
            <h1>OpenZaps app</h1>
            <p>Build an immutable intent locker. Fund it, sign a policy, let Hermes run it.</p>
          </div>
        </div>
        <div className={styles.wallet}>
          {demo ? (
            <>
              <span className={styles.addr}>{address}</span>
              <button className="btn btnGhost" onClick={() => setDemo(false)}>
                Disconnect
              </button>
            </>
          ) : (
            <button className="btn btnPrimary" onClick={() => setDemo(true)}>
              {live ? "Connect wallet" : "Preview with demo wallet"}
            </button>
          )}
        </div>
      </section>

      {/* builder + intent */}
      <section className={`container ${styles.grid}`}>
        <div className={styles.builder}>
          <div className={styles.cardHead}>Create a zap</div>

          <div className={styles.field} role="group" aria-label="Authority model">
            <span>Authority model</span>
            <div className={styles.segment}>
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  className={model === m.id ? styles.segOn : styles.seg}
                  onClick={() => setModel(m.id)}
                  aria-pressed={model === m.id}
                  type="button"
                >
                  {m.label}
                  <em>{m.hint}</em>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.pair}>
            <label className={styles.field}>
              <span>From</span>
              <select value={tokenIn} onChange={(e) => setTokenIn(e.target.value)} className={styles.select}>
                {TOKENS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>To</span>
              <select value={tokenOut} onChange={(e) => setTokenOut(e.target.value)} className={styles.select}>
                {TOKENS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={styles.pair}>
            <label className={styles.field}>
              <span>Amount in ({tokenIn})</span>
              <input
                className={styles.input}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="1000"
              />
            </label>
            <label className={styles.field}>
              <span>Max slippage (%)</span>
              <input
                className={styles.input}
                inputMode="decimal"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0.5"
              />
            </label>
          </div>

          {sameToken && (
            <p id="zap-warn" className={styles.warn}>
              Pick two different tokens for the route.
            </p>
          )}

          <button
            className={`btn btnPrimary btnLg ${styles.create}`}
            onClick={createZap}
            disabled={sameToken}
            aria-describedby={sameToken ? "zap-warn" : undefined}
          >
            {demo ? "Simulate create" : "Build zap"}
            <span aria-hidden>→</span>
          </button>
          <p className={styles.fineprint}>
            {live
              ? "Deploys an immutable, single-policy clone. You keep an unconditional withdraw."
              : "Preview only — no transaction is broadcast. Deploys an immutable clone at launch."}
          </p>
        </div>

        <aside className={styles.intent}>
          <div className={styles.cardHead}>Signed policy preview</div>
          <pre className={styles.json}>
{`OpenZapIntent {
  chainId:       ${intent.chainId}
  recipient:     ${intent.recipient}
  route:         ${intent.route}
  amountIn:      ${intent.amountIn}
  minOut:        ${intent.minOut}
  maxRelayerFee: ${intent.maxRelayerFee}
  deadline:      ${intent.deadline}
  optimization:  ${String(intent.optimization)}
  policyHash:    ${intent.policyHash}
}`}
          </pre>
          <ul className={styles.guarantees}>
            <li>No arbitrary calls — fixed adapter only</li>
            <li>Exact approval, reset to zero</li>
            <li>Recipient + min-out bound in the signature</li>
            <li>Owner-only emergency exit, always</li>
          </ul>
        </aside>
      </section>

      {/* dashboard */}
      <section className={`container ${styles.dash}`}>
        <div className={styles.dashHead}>
          <h2>Your zaps</h2>
          <span className={styles.dashCount} aria-live="polite">
            {zaps.length} active
          </span>
        </div>
        {zaps.length === 0 ? (
          <div className={styles.empty}>
            <OpenZapMark className={styles.emptyMark} />
            <strong>No zaps yet</strong>
            <p>Build one above. Each zap is its own immutable contract with isolated funds.</p>
          </div>
        ) : (
          <div className={styles.table}>
            <div className={styles.tableHead}>
              <span>Policy</span>
              <span>Route</span>
              <span>Amount</span>
              <span>Model</span>
              <span>Status</span>
            </div>
            {zaps.map((z) => (
              <div className={styles.tableRow} key={z.id}>
                <span className={styles.mono}>{z.id}</span>
                <span>{z.route}</span>
                <span>{z.amount}</span>
                <span className={styles.cap}>{z.model}</span>
                <span className={styles.statusTag}>preview</span>
              </div>
            ))}
          </div>
        )}
        <p className={styles.dashNote}>
          Live zaps, balances, and Hermes execution receipts appear here once {TOKEN.symbol} launches and the
          contracts are deployed on {CHAIN.name}.
        </p>
      </section>
    </main>
  );
}
