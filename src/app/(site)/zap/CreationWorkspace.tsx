import type { ReactNode } from "react";

import { BlockGlyph } from "./BlockGlyph";
import styles from "./creation-workspace.module.css";

export interface CreationFact {
  label: string;
  value: ReactNode;
  href?: string;
  mono?: boolean;
}

export interface CreationStage {
  label: string;
  detail: string;
  status: "done" | "current" | "pending";
}

interface CreationWorkspaceProps {
  eyebrow: string;
  title: string;
  detail: string;
  facts: readonly CreationFact[];
  stages: readonly CreationStage[];
  children: ReactNode;
}

/** Durable, evidence-first receipt shown after a confirmed Zap creation. */
export function CreationWorkspace({
  eyebrow,
  title,
  detail,
  facts,
  stages,
  children,
}: CreationWorkspaceProps): React.JSX.Element {
  return (
    <section className={styles.workspace} aria-labelledby="creation-workspace-title">
      <header className={styles.head}>
        <div className={styles.illustration} aria-hidden>
          <span><BlockGlyph name="tick" /></span>
          <i />
          <span><BlockGlyph name="lock" /></span>
          <i />
          <span><BlockGlyph name="bolt" /></span>
        </div>
        <div className={styles.copy}>
          <span className={styles.eyebrow}>{eyebrow}</span>
          <h2 id="creation-workspace-title">{title}</h2>
          <p>{detail}</p>
        </div>
        <span className={styles.confirmed}>
          <BlockGlyph name="tick" />
          Confirmed
        </span>
      </header>

      <dl className={styles.facts}>
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd data-mono={fact.mono || undefined}>
              {fact.href ? (
                <a href={fact.href} target="_blank" rel="noreferrer">{fact.value} ↗</a>
              ) : fact.value}
            </dd>
          </div>
        ))}
      </dl>

      <ol className={styles.stages} aria-label="Zap progress after creation">
        {stages.map((stage, index) => (
          <li data-status={stage.status} key={stage.label}>
            <span>{stage.status === "done" ? <BlockGlyph name="tick" /> : index + 1}</span>
            <div>
              <strong>{stage.label}</strong>
              <small>{stage.detail}</small>
            </div>
          </li>
        ))}
      </ol>

      <footer className={styles.actions}>
        <div>
          <strong>Creation is complete.</strong>
          <span>The Zap stays inspectable here until you intentionally start another.</span>
        </div>
        <nav aria-label="Creation result actions">{children}</nav>
      </footer>
    </section>
  );
}
