"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  RECIPES,
  compileChain,
  encodeChain,
  getBlock,
  makeNode,
  type ChainNode,
} from "@/lib/blocks";
import { CHAIN } from "@/lib/config";
import { reducedMotion } from "./motion";
import styles from "./landing.module.css";

/**
 * The simulated Zap execution interface. This is not a mock: the chain is
 * assembled from the real block catalog and compiled by the same
 * `compileChain` the builder uses, in the browser. What it deliberately does
 * NOT do is invent numbers — quotes and output amounts exist only at sign
 * time on /zap, so the preview shows structure, checks, and constraints, and
 * hands off to the real surface.
 */

const DEMO_IDS = ["stitched-route", "provide-liquidity", "exit-liquidity", "live-route"] as const;

type Phase = "idle" | "running" | "done";

const DEMO_RECIPES = RECIPES.filter((recipe) =>
  (DEMO_IDS as readonly string[]).includes(recipe.id),
);

function buildChain(recipeId: string, amount: string): ChainNode[] | null {
  const recipe = RECIPES.find((r) => r.id === recipeId);
  if (!recipe) return null;
  return recipe.blocks.map(([blockId, params], index) => {
    const overrides = { ...params };
    if (index === 0 && params && "amount" in params) overrides.amount = amount;
    return makeNode(blockId, `demo-${recipe.id}-${index}`, overrides);
  });
}

export function ExecutionDemo(): React.JSX.Element {
  const recipes = DEMO_RECIPES;
  const [recipeId, setRecipeId] = useState<string>(recipes[0]?.id ?? "");
  const [amount, setAmount] = useState<string>("25");
  const [phase, setPhase] = useState<Phase>("idle");
  const [stage, setStage] = useState(0);
  const timers = useRef<number[]>([]);

  const recipe = recipes.find((r) => r.id === recipeId) ?? recipes[0];
  const sourceParams = (recipe?.blocks[0]?.[1] ?? {}) as { asset?: string; amount?: string };
  const inputAsset = typeof sourceParams.asset === "string" ? sourceParams.asset : "ozRANGE";

  const amountValid = /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount) > 0;
  // Pure and cheap on chains this small — the React Compiler memoizes renders,
  // so no manual useMemo bookkeeping here.
  const chain = recipe && amountValid ? buildChain(recipe.id, amount.trim()) : null;
  const compiled = chain ? compileChain(chain) : null;
  const shareHref = chain ? `/zap?d=${encodeChain(chain)}` : "/zap";

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  const preview = () => {
    if (!compiled) return;
    clearTimers();
    if (reducedMotion()) {
      setStage(compiled.checks.length + 1);
      setPhase("done");
      return;
    }
    setPhase("running");
    setStage(0);
    compiled.checks.forEach((_, i) => {
      timers.current.push(window.setTimeout(() => setStage(i + 1), 260 * (i + 1)));
    });
    timers.current.push(
      window.setTimeout(() => {
        setStage(compiled.checks.length + 1);
        setPhase("done");
      }, 260 * (compiled.checks.length + 1) + 200),
    );
  };

  const reset = (nextId?: string, nextAmount?: string) => {
    clearTimers();
    setPhase("idle");
    setStage(0);
    if (nextId !== undefined) setRecipeId(nextId);
    if (nextAmount !== undefined) setAmount(nextAmount);
  };

  if (!recipe || recipes.length === 0) return <></>;

  return (
    <div className={styles.demo}>
      <form
        className={styles.demoForm}
        onSubmit={(event) => {
          event.preventDefault();
          preview();
        }}
      >
        <div className={styles.demoField}>
          <label htmlFor="demo-intent" className={`${styles.demoLabel} mono`}>
            Intent
          </label>
          <select
            id="demo-intent"
            className={styles.demoSelect}
            value={recipe.id}
            onChange={(event) => reset(event.target.value)}
          >
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.demoField}>
          <label htmlFor="demo-amount" className={`${styles.demoLabel} mono`}>
            Amount · {inputAsset}
          </label>
          <input
            id="demo-amount"
            className={styles.demoInput}
            inputMode="decimal"
            value={amount}
            onChange={(event) => reset(undefined, event.target.value)}
            aria-invalid={!amountValid || undefined}
          />
        </div>

        <div className={styles.demoField}>
          <span className={`${styles.demoLabel} mono`}>Network</span>
          <span className={styles.demoNetwork}>
            <span className={styles.demoNetworkDot} aria-hidden="true" />
            {CHAIN.name} · {CHAIN.id}
          </span>
        </div>

        <button
          type="submit"
          className="btn btnPrimary"
          data-magnetic
          disabled={!amountValid}
        >
          <span>Preview Zap</span>
        </button>
      </form>

      {!amountValid ? (
        <p className={`${styles.demoError} mono`} role="alert">
          Enter a positive amount to compile the route.
        </p>
      ) : null}

      <div className={styles.demoOutput} data-phase={phase}>
        {compiled ? (
          <>
            <div className={styles.demoRoute}>
              <span className={`${styles.demoRouteKicker} mono`}>compiled route</span>
              <ol className={styles.demoRouteSteps}>
                {(chain ?? []).map((node, i) => {
                  const block = getBlock(node.blockId);
                  return (
                    <li key={node.uid} className={styles.demoRouteStep}>
                      <span className="mono">{String(i + 1).padStart(2, "0")}</span>
                      {block?.name ?? node.blockId}
                    </li>
                  );
                })}
              </ol>
            </div>

            <div className={styles.demoChecks}>
              {/* Only the phase word is live — announcing per keystroke or on
                  the whole output panel would spam screen readers. */}
              <span className={`${styles.demoRouteKicker} mono`}>
                simulation ·{" "}
                <span aria-live="polite">
                  {phase === "idle" ? "ready" : phase === "running" ? "running" : "complete"}
                </span>
              </span>
              <ul>
                {compiled.checks.map((check, i) => (
                  <li
                    key={`${check.label}-${i}`}
                    className={styles.demoCheck}
                    data-shown={phase !== "idle" && stage > i ? "true" : undefined}
                    data-status={check.status}
                  >
                    <span className={styles.demoCheckMark} aria-hidden="true" />
                    <span>{check.label}</span>
                    <span className={`${styles.demoCheckDetail} mono`}>{check.detail}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div
              className={styles.demoVerdict}
              data-shown={phase === "done" ? "true" : undefined}
            >
              <dl className={`${styles.demoVerdictGrid} mono`}>
                <div>
                  <dt>status</dt>
                  <dd data-status={compiled.status}>{compiled.status}</dd>
                </div>
                <div>
                  <dt>signed steps</dt>
                  <dd>1</dd>
                </div>
                <div>
                  <dt>gas constant</dt>
                  <dd>{compiled.gas.toLocaleString("en-US")}</dd>
                </div>
                <div>
                  <dt>guard cover</dt>
                  <dd>{compiled.guardScore}/100</dd>
                </div>
                <div>
                  <dt>design hash</dt>
                  <dd>{compiled.hash.slice(0, 10)}…</dd>
                </div>
              </dl>
              <p className={styles.demoHonesty}>
                Output amounts are quoted live at sign time, never estimated here.
              </p>
              <div className={styles.demoActions}>
                <Link href={shareHref} className="btn btnGhost" data-magnetic>
                  <span>Open in builder</span>
                </Link>
                <Link href="/zap?view=sign" className="btn btnPrimary" data-magnetic>
                  <span>Sign &amp; run</span>
                </Link>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
