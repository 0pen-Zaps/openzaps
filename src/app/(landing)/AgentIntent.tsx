"use client";

import { useState } from "react";
import type { AgentPlan } from "./data";
import styles from "./landing.module.css";

/**
 * Agent execution: an intent on the left becomes a bounded plan on the right.
 * Every fact in the plan is registry truth — the adapter label and address,
 * its one-sentence refusal, the router's numeric ceilings, and the compiled
 * simulation checks. The point is the asymmetry: the agent may hold the
 * trigger; the capsule decides what the trigger can do.
 */
export function AgentIntent({ plans }: { plans: AgentPlan[] }): React.JSX.Element {
  const [activeId, setActiveId] = useState(plans[0]?.id ?? "");
  const active = plans.find((plan) => plan.id === activeId) ?? plans[0];

  if (!active) return <></>;

  return (
    <div className={styles.agent}>
      {/* Toggle buttons, not ARIA tabs: only one plan is mounted at a time,
          and the group legally contains the prompt label and note. */}
      <div className={styles.agentIntents} role="group" aria-label="Agent intents">
        <span className={`${styles.agentPrompt} mono`}>agent intent</span>
        {plans.map((plan) => (
          <button
            key={plan.id}
            type="button"
            aria-pressed={plan.id === active.id}
            className={styles.agentIntent}
            onClick={() => setActiveId(plan.id)}
          >
            <span className={`${styles.agentCaret} mono`} aria-hidden="true">
              ›
            </span>
            {plan.intent}
          </button>
        ))}
        <p className={styles.agentNote}>
          The agent can hold the trigger. It cannot change what the trigger
          does: target, calldata shape, recipient, and asset are welded in
          before signing.
        </p>
      </div>

      <div key={active.id} className={styles.agentPlan}>
        <div className={styles.agentRow}>
          <span className={`${styles.agentRowKey} mono`}>route</span>
          <span className={styles.agentRowValue}>{active.route}</span>
        </div>
        <div className={styles.agentRow}>
          <span className={`${styles.agentRowKey} mono`}>adapter</span>
          <span className={`${styles.agentRowValue} mono`}>
            {active.adapterAddress.slice(0, 10)}…{active.adapterAddress.slice(-6)}
          </span>
        </div>
        <div className={styles.agentRow}>
          <span className={`${styles.agentRowKey} mono`}>constraints</span>
          <ul className={styles.agentConstraints}>
            {active.constraints.map((constraint) => (
              <li key={constraint}>{constraint}</li>
            ))}
          </ul>
        </div>
        <div className={styles.agentRow}>
          <span className={`${styles.agentRowKey} mono`}>simulation</span>
          <ul className={styles.agentChecks}>
            {active.checks.slice(0, 4).map((check, i) => (
              <li key={i} data-status={check.status}>
                <span className={styles.demoCheckMark} aria-hidden="true" />
                {check.label}
              </li>
            ))}
          </ul>
        </div>
        <div className={`${styles.agentRefuses}`}>
          <span className={`${styles.agentRowKey} mono`}>refuses</span>
          <p>{active.refuses}</p>
        </div>
      </div>
    </div>
  );
}
