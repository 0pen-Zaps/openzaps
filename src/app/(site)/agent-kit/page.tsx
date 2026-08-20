import Link from "next/link";

import { CopyButton } from "@/components/CopyButton";
import { JsonLd } from "@/components/JsonLd";
import { LINKS } from "@/lib/config";
import {
  mcpClientSnippet,
  OPENZAPS_AGENT_KIT_PUBLISHED,
  OPENZAPS_MCP_PACKAGE_SPEC,
  OPENZAPS_SDK_INSTALL_COMMAND,
  OPENZAPS_SDK_PACKAGE_SPEC,
} from "@/lib/agent-kit";
import {
  STATIC_PAGE_SEO,
  breadcrumbJsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";

import styles from "./agent-kit.module.css";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.agentKit,
  keywords: [
    "OpenZaps Agent Kit",
    "AI agent DeFi SDK",
    "read-only DeFi MCP server",
    "bounded agent authority",
    "unsigned EIP-712",
  ],
});

const REQUEST_URL =
  "/request-a-zap?utm_source=openzaps&utm_medium=website&utm_campaign=openzaps-agent-kit&utm_content=agent_kit";

const SDK_REGISTRY_URL =
  "https://registry.npmjs.org/@openzaps%2fsdk/0.1.0";
const MCP_REGISTRY_URL =
  "https://registry.npmjs.org/@openzaps%2fmcp/0.1.0";
const SDK_SOURCE_URL =
  "https://github.com/0pen-Zaps/openzaps/tree/main/packages/sdk";
const MCP_SOURCE_URL =
  "https://github.com/0pen-Zaps/openzaps/tree/main/packages/mcp";

const BOUNDS = [
  {
    number: "01",
    title: "The owner creates authority",
    body:
      "Your wallet or Safe reviews the route, funds the capsule, and signs any standing intent. The Agent Kit never receives the owner key or signature authority.",
  },
  {
    number: "02",
    title: "The policy freezes the terms",
    body:
      "Target, adapter, recipient, asset, amount, calldata shape, cadence, output limits, and executor eligibility remain inside the immutable capsule or signed intent.",
  },
  {
    number: "03",
    title: "A separate executor may submit",
    body:
      "For a standing recurring or triggered intent, a separately operated executor may submit a due run. It cannot widen the terms, move early, repeat a run, or reach funds outside the capsule.",
  },
] as const;

export default function AgentKitPage(): React.JSX.Element {
  const mcpSnippet = mcpClientSnippet();

  return (
    <main
      className={styles.page}
      id="main"
      data-screen-label="Agent Kit"
      data-agent-kit-boundary="read-only-and-unsigned"
      data-agent-kit-packages-published="true"
      data-agent-kit-install-enabled={OPENZAPS_AGENT_KIT_PUBLISHED}
    >
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            webPageJsonLd(STATIC_PAGE_SEO.agentKit),
            breadcrumbJsonLd("/agent-kit", "Agent Kit"),
            {
              "@type": "SoftwareApplication",
              "@id": "https://www.0xzaps.com/agent-kit#software",
              name: "OpenZaps Agent Kit",
              applicationCategory: "DeveloperApplication",
              softwareRequirements: "Node.js 20 or newer",
              softwareVersion: "0.1.0",
              url: "https://www.0xzaps.com/agent-kit",
              isPartOf: { "@id": "https://www.0xzaps.com/#website" },
            },
          ],
        }}
      />

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span aria-hidden />
            Published packages · npm provenance
          </p>
          <h1>Connect an AI agent without handing it a wallet key.</h1>
          <p className={styles.lead}>
            Start with read-only capsule discovery and exact, unsigned policy
            preparation. Neither package signs or broadcasts, and neither can
            widen the authority your wallet or Safe creates.
          </p>
          <div className={styles.actions}>
            <a
              className={styles.primaryAction}
              href="#install"
              data-analytics-event="builder_cta_clicked"
              data-analytics-cta="agent_kit_install"
              data-analytics-content="agent_kit"
            >
              See the packages <span aria-hidden>↓</span>
            </a>
            <Link
              className={styles.secondaryAction}
              href={REQUEST_URL}
              data-analytics-event="request_zap_clicked"
              data-analytics-cta="request_zap"
              data-analytics-content="agent_kit"
            >
              Request an authority map
            </Link>
          </div>
        </div>

        <aside className={styles.releaseCard} aria-label="Agent Kit release status">
          <span>Release status</span>
          <strong>Two attested packages. Zero signing methods.</strong>
          <dl>
            <div>
              <dt>SDK</dt>
              <dd>{OPENZAPS_SDK_PACKAGE_SPEC}</dd>
            </div>
            <div>
              <dt>MCP</dt>
              <dd>{OPENZAPS_MCP_PACKAGE_SPEC}</dd>
            </div>
            <div>
              <dt>Authority</dt>
              <dd>Read-only and unsigned</dd>
            </div>
          </dl>
          <p>
            Neither package holds a wallet key. npm provenance links each
            release to the OpenZaps repository and publishing workflow.
            Provenance is not an external security audit.
          </p>
        </aside>
      </section>

      <section className={styles.packages} id="install" aria-labelledby="packages-heading">
        <header className={styles.sectionHeading}>
          <p>Published surface</p>
          <h2 id="packages-heading">Prepare and inspect. Never sign or send.</h2>
          <span>
            Package publication and the production simulation route are separate
            gates. Exact simulation is deployment-gated and fails closed when
            its provider or durable quota is unavailable.
          </span>
        </header>

        <div className={styles.packageGrid}>
          <article className={styles.packageCard}>
            <div className={styles.packageTop}>
              <span>TypeScript SDK</span>
              <a href={SDK_REGISTRY_URL} target="_blank" rel="noreferrer noopener">
                Registry <i aria-hidden>↗</i>
              </a>
            </div>
            <h3>{OPENZAPS_SDK_PACKAGE_SPEC}</h3>
            <p>
              Compiles the exact Solidity policy tuple, hashes it, prepares
              unsigned EIP-712 data, and requests block-pinned simulation. Its
              client has no signing or transaction-broadcast method.
            </p>
            {OPENZAPS_AGENT_KIT_PUBLISHED ? (
              <div className={styles.commandRow}>
                <code>{OPENZAPS_SDK_INSTALL_COMMAND}</code>
                <CopyButton
                  className={styles.copyButton}
                  value={OPENZAPS_SDK_INSTALL_COMMAND}
                  label="Copy"
                  ariaLabel="Copy SDK install command"
                  title="Copy SDK install command"
                />
              </div>
            ) : (
              <p className={styles.gateNotice}>
                These packages are published, but this deployment has not enabled
                its install snippets.
              </p>
            )}
            <a className={styles.sourceLink} href={SDK_SOURCE_URL} target="_blank" rel="noreferrer noopener">
              Inspect SDK source <span aria-hidden>→</span>
            </a>
          </article>

          <article className={styles.packageCard}>
            <div className={styles.packageTop}>
              <span>Read-only MCP</span>
              <a href={MCP_REGISTRY_URL} target="_blank" rel="noreferrer noopener">
                Registry <i aria-hidden>↗</i>
              </a>
            </div>
            <h3>{OPENZAPS_MCP_PACKAGE_SPEC}</h3>
            <p>
              Gives compatible agent clients capsule and intent discovery plus
              block-pinned simulation. It cannot sign, publish, relay, fund,
              revoke, or broadcast a transaction.
            </p>
            {OPENZAPS_AGENT_KIT_PUBLISHED ? (
              <div className={styles.codeShell}>
                <div>
                  <span>Client config</span>
                  <CopyButton
                    className={styles.copyButton}
                    value={mcpSnippet}
                    label="Copy"
                    ariaLabel="Copy MCP client configuration"
                    title="Copy MCP client configuration"
                  />
                </div>
                <pre><code>{mcpSnippet}</code></pre>
              </div>
            ) : (
              <p className={styles.gateNotice}>
                These packages are published, but this deployment has not enabled
                its install snippets.
              </p>
            )}
            <a className={styles.sourceLink} href={MCP_SOURCE_URL} target="_blank" rel="noreferrer noopener">
              Inspect MCP source <span aria-hidden>→</span>
            </a>
          </article>
        </div>
      </section>

      <section className={styles.authority} aria-labelledby="authority-heading">
        <header className={styles.sectionHeading}>
          <p>Authority map</p>
          <h2 id="authority-heading">The agent gets visibility, not a blank check.</h2>
          <span>
            One-shot Zaps cannot be connected. Executor pinning applies only to
            standing recurring, relative, or triggered intents that already name
            the eligible submitting address.
          </span>
        </header>
        <div className={styles.boundGrid}>
          {BOUNDS.map((bound) => (
            <article key={bound.number}>
              <span>{bound.number}</span>
              <h3>{bound.title}</h3>
              <p>{bound.body}</p>
            </article>
          ))}
        </div>
        <div className={styles.boundaryNote}>
          <strong>Discovery is not authority.</strong>
          <p>
            Capsule and profile reads are chain-derived. Relay-listed intents
            and connections may be stale and are not proof of current onchain
            authority. Verify the capsule, lineage, executor field, and current
            onchain state before treating a run as eligible.
          </p>
          <Link href="/docs#agents">Read the connection model <span aria-hidden>→</span></Link>
        </div>
      </section>

      <section className={styles.conversion}>
        <div>
          <p>Start with a policy sketch</p>
          <h2>Show us one workflow. We’ll map the agent’s exact limits.</h2>
          <span>
            Describe the trigger, target, asset, amount, recipient, cadence, and
            failure limits. Never share a private key, seed phrase, signature,
            wallet balance, or signing authority.
          </span>
        </div>
        <div className={styles.conversionActions}>
          <Link
            href={REQUEST_URL}
            data-analytics-event="request_zap_clicked"
            data-analytics-cta="request_zap"
            data-analytics-content="agent_kit"
          >
            Request a Zap <span aria-hidden>→</span>
          </Link>
          <a
            href={LINKS.discord}
            target="_blank"
            rel="noreferrer noopener"
            data-analytics-event="growth_link_clicked"
            data-analytics-cta="discord"
            data-analytics-content="agent_kit"
          >
            Ask in Discord <span aria-hidden>↗</span>
          </a>
        </div>
      </section>

      <p className={styles.disclosure}>
        <strong>Pre-audit software.</strong> OpenZaps contracts are live on
        Robinhood Chain with real funds.
        The Agent Kit itself cannot sign or broadcast, but that does not make
        live contract use risk-free. Verify the package version, provenance,
        current onchain state, and exact policy before signing. Onchain actions
        are irreversible.
      </p>
    </main>
  );
}
