"use client";

import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import styles from "./landing.module.css";

/**
 * The developer code panel. The snippet is the repo's real API — the same
 * `makeNode`/`compileChain`/`encodeChain` this landing page itself calls —
 * and the response panel shows values compiled server-side from that exact
 * chain. Lines type in once the panel scrolls into view; reduced motion (or
 * no JS) shows everything immediately.
 */

type Token = { text: string; kind?: "kw" | "str" | "fn" | "num" | "cm" | "pr" };
type Line = Token[];

const CODE_LINES: Line[] = [
  [
    { text: "import", kind: "kw" },
    { text: " { compileChain, encodeChain, makeNode } " },
    { text: "from", kind: "kw" },
    { text: " \"@/lib/blocks\"", kind: "str" },
    { text: ";" },
  ],
  [],
  [
    { text: "const", kind: "kw" },
    { text: " chain = [" },
  ],
  [
    { text: "  " },
    { text: "makeNode", kind: "fn" },
    { text: "(" },
    { text: "\"wallet-balance\"", kind: "str" },
    { text: ", " },
    { text: "\"src\"", kind: "str" },
    { text: ", { asset: " },
    { text: "\"USDG\"", kind: "str" },
    { text: ", amount: " },
    { text: "\"25\"", kind: "str" },
    { text: " })," },
  ],
  [
    { text: "  " },
    { text: "makeNode", kind: "fn" },
    { text: "(" },
    { text: "\"guard-slippage\"", kind: "str" },
    { text: ", " },
    { text: "\"cap\"", kind: "str" },
    { text: ", { bps: " },
    { text: "50", kind: "num" },
    { text: " })," },
  ],
  [
    { text: "  " },
    { text: "makeNode", kind: "fn" },
    { text: "(" },
    { text: "\"swap\"", kind: "str" },
    { text: ", " },
    { text: "\"leg\"", kind: "str" },
    { text: ", { into: " },
    { text: "\"0xZAPS\"", kind: "str" },
    { text: " })," },
  ],
  [
    { text: "  " },
    { text: "makeNode", kind: "fn" },
    { text: "(" },
    { text: "\"send\"", kind: "str" },
    { text: ", " },
    { text: "\"out\"", kind: "str" },
    { text: ")," },
  ],
  [{ text: "];" }],
  [],
  [
    { text: "const", kind: "kw" },
    { text: " verdict = " },
    { text: "compileChain", kind: "fn" },
    { text: "(chain);" },
  ],
  [
    { text: "const", kind: "kw" },
    { text: " link = " },
    { text: "`/use?d=${", kind: "str" },
    { text: "encodeChain", kind: "fn" },
    { text: "(chain)}`", kind: "str" },
    { text: ";" },
  ],
  [
    { text: "// every chain is a shareable, executable link", kind: "cm" },
  ],
];

const PLAIN_CODE = `import { compileChain, encodeChain, makeNode } from "@/lib/blocks";

const chain = [
  makeNode("wallet-balance", "src", { asset: "USDG", amount: "25" }),
  makeNode("guard-slippage", "cap", { bps: 50 }),
  makeNode("swap", "leg", { into: "0xZAPS" }),
  makeNode("send", "out"),
];

const verdict = compileChain(chain);
const link = \`/use?d=\${encodeChain(chain)}\`;
// every chain is a shareable, executable link`;

export type DevVerdict = {
  status: string;
  gas: number;
  guardScore: number;
  hash: string;
  steps: string[];
};

export function DevPanel({ verdict }: { verdict: DevVerdict }): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  // Server renders the code visible (crawlers, no-JS). On mount the client
  // "arms" the panel — hiding the lines — only if the type-in animation still
  // has a chance to play before the user sees it.
  const [state, setState] = useState<"plain" | "armed" | "typed">("plain");

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.9) {
      setState("typed");
      return;
    }
    setState("armed");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setState("typed");
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={panelRef} className={styles.dev} data-code={state}>
      <div className={styles.devCode}>
        <div className={styles.devCodeBar}>
          <span className="mono">src/lib/blocks.ts · MIT · runs in this page</span>
          <CopyButton value={PLAIN_CODE} label="Copy" className={styles.devCopy} />
        </div>
        <pre className={styles.devPre}>
          <code>
            {CODE_LINES.map((line, i) => (
              <span
                key={i}
                className={styles.devLine}
                style={{ "--line-i": i } as React.CSSProperties}
              >
                {line.length === 0
                  ? " "
                  : line.map((token, j) => (
                      <span key={j} data-tok={token.kind}>
                        {token.text}
                      </span>
                    ))}
              </span>
            ))}
          </code>
        </pre>
      </div>

      <div className={styles.devOut}>
        <div className={styles.devOutBar}>
          <span className={styles.devOutDot} aria-hidden="true" />
          <span className="mono">verdict</span>
        </div>
        <dl className={`${styles.devOutGrid} mono`}>
          <div>
            <dt>status</dt>
            <dd data-status={verdict.status}>{verdict.status}</dd>
          </div>
          <div>
            <dt>gas</dt>
            <dd>{verdict.gas.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>guardScore</dt>
            <dd>{verdict.guardScore}</dd>
          </div>
          <div>
            <dt>hash</dt>
            <dd>{verdict.hash.slice(0, 10)}…</dd>
          </div>
        </dl>
        <ol className={`${styles.devOutSteps} mono`}>
          {verdict.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <p className={`${styles.devOutNote} mono`}>
          POST /api/policies/simulate — deterministic policy simulation over HTTP
        </p>
      </div>
    </div>
  );
}
