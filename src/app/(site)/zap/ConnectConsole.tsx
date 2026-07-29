"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAddress, isAddress, isAddressEqual, type Address } from "viem";

import { CopyButton } from "@/components/CopyButton";
import { Transcript } from "@/components/Transcript";
import { useWalletSession } from "@/components/WalletProvider";
import { agentAliasStorageKey, parseAgentAliases, type AgentAliases } from "@/lib/agent-connection";
import { mcpClientSnippet, OPENZAPS_AGENT_KIT_PUBLISHED } from "@/lib/agent-kit";
import type { NarrativeAuthorization } from "@/lib/agent-narrative";
import {
  automationIntentKey,
  parseAutomationIntent,
  type ParsedAutomationIntent,
} from "@/lib/automation-records";
import { deriveAutomationLifecycle } from "@/lib/automation-status";
import {
  AGENT_CANNOT,
  CONNECT_CHIPS,
  connectDialogue,
  connectHandoff,
  type ConnectAccess,
  type ConnectCapsule,
  type ConnectMode,
  type ConnectProposal,
  type ConnectSelection,
} from "@/lib/connect-dialogue";
import { isStandingIntentLineage, type WalletProfilePayload } from "@/lib/profile";
import { fetchOwnerIntentPage, type RelayRecord } from "@/lib/relay";
import { explorerTransaction } from "@/lib/robinhood";
import type { TranscriptChip } from "@/lib/transcript";
import styles from "./connect.module.css";

/**
 * Connect — pin the agent allowed to submit your runs.
 *
 * The screen's whole claim is that connecting an agent gives it a trigger and never any authority,
 * and the implementation has to earn that: this component reads, links, and explains. It does not
 * sign, publish, or POST anything. Its terminal act is a link into the Automate console carrying
 * query params that console re-validates on arrival.
 *
 * Search params arrive as PROPS rather than through useSearchParams. UseSurface already reads them
 * behind the page's Suspense boundary, and adding a second boundary here whose fallback rendered
 * children would mount every screen twice — two <main>, two sets of mount effects, two RPC polls.
 */
export default function ConnectConsole({ proposedAgent }: { proposedAgent?: string | null }): React.JSX.Element {
  const { account, providerAvailable, isRobinhoodChain, connect, switchToRobinhood } = useWalletSession();
  const [selection, setSelection] = useState<ConnectSelection>({});
  const [profile, setProfile] = useState<WalletProfilePayload | null>(null);
  const [relayRecords, setRelayRecords] = useState<RelayRecord[]>([]);
  const [relayHasOlder, setRelayHasOlder] = useState(false);
  const [aliases, setAliases] = useState<AgentAliases>({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** The account a landing response must still match, read at resolve time. */
  const accountRef = useRef<Address | null>(account);
  const [agentConfigured, setAgentConfigured] = useState(false);
  const [composing, setComposing] = useState(false);
  const [proposal, setProposal] = useState<ConnectProposal | null>(null);
  const [refusal, setRefusal] = useState<{ reason: string; issues: string[] } | null>(null);

  const agent = useMemo(
    () => (proposedAgent && isAddress(proposedAgent) ? getAddress(proposedAgent) : null),
    [proposedAgent],
  );

  const load = useCallback(
    async (owner: Address): Promise<void> => {
      setLoading(true);
      setError("");
      const [profileResult, relayResult] = await Promise.allSettled([
        fetch(`/api/profile/${owner}`, { cache: "no-store" }).then(async (response) => {
          if (!response.ok) throw new Error(`Profile read failed (HTTP ${response.status}).`);
          return response.json() as Promise<WalletProfilePayload>;
        }),
        fetchOwnerIntentPage(owner),
      ]);

      // Drop a response for a wallet that is no longer connected. Without this,
      // switching A→B while A is in flight lets A's slower response land last:
      // `loaded` reverts to A while `account` is B, the loading test can never
      // clear, and the screen sits on "Reading your capsules…" forever — holding
      // the previous wallet's capsules behind it.
      if (!accountRef.current || !isAddressEqual(accountRef.current, owner)) return;

      if (profileResult.status === "fulfilled") {
        setProfile(profileResult.value);
      } else {
        // Fail closed. Rendering zero capsules here would tell someone they have
        // nothing to connect, which is a claim about the chain nobody verified.
        setProfile(null);
        setError(profileResult.reason instanceof Error ? profileResult.reason.message : "Your capsules could not be read.");
      }
      setRelayRecords(relayResult.status === "fulfilled" ? relayResult.value.intents : []);
      setRelayHasOlder(
        relayResult.status === "fulfilled" && relayResult.value.nextCursor !== null,
      );
      setAliases(readAliases(owner));
      setLoaded(owner.toLowerCase());
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  // Load once per connected account. setState happens inside the async callback,
  // never synchronously in the effect body — the same shape ProfileDashboard uses.
  useEffect(() => {
    if (!account) return;
    const frame = window.requestAnimationFrame(() => void load(account));
    return () => window.cancelAnimationFrame(frame);
  }, [account, load]);

  // Ask whether this deployment has a model before offering a text box that
  // would 503 on submit. A failed probe means "no", which is the safe reading.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/agent", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ configured?: boolean }>) : null))
      .then((body) => {
        if (!cancelled) setAgentConfigured(body?.configured === true);
      })
      .catch(() => {
        if (!cancelled) setAgentConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const compose = useCallback(async (prompt: string): Promise<void> => {
    setComposing(true);
    setError("");
    setProposal(null);
    setRefusal(null);
    try {
      const response = await fetch("/api/agent/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const body = (await response.json()) as
        | { ok: true; plan: ConnectProposal["plan"]; rationale: string }
        | { ok: false; refusal?: { reason: string; issues: string[] }; error?: string };

      if (body.ok) {
        setProposal({ plan: body.plan, rationale: body.rationale });
      } else if (body.refusal) {
        // A refusal is an answer, not a failure — it renders as a capsule
        // message carrying the compiler's own sentences.
        setRefusal(body.refusal);
      } else {
        setError(body.error ?? "The agent could not answer that.");
      }
    } catch {
      setError("The agent could not be reached.");
    } finally {
      setComposing(false);
    }
  }, []);

  const capsules = useMemo((): ConnectCapsule[] => {
    if (!profile) return [];
    return profile.zaps
      .filter((zap) => isStandingIntentLineage(zap.lineage))
      .map((zap) => ({
        address: zap.address,
        lineage: zap.lineage,
        automatedRunCount: zap.automatedRunCount,
      }));
  }, [profile]);

  const authorizations = useMemo((): NarrativeAuthorization[] => {
    if (!account) return [];
    return relayRecords.flatMap((record): NarrativeAuthorization[] => {
      const intent = parseRelayIntent(record);
      if (!intent) return [];
      return [
        {
          key: automationIntentKey(intent),
          zap: intent.zap,
          intent,
          // No chain read on this screen: connect is about WHO may submit, and
          // "unavailable" is the honest lifecycle for a state we did not read.
          state: deriveAutomationLifecycle(intent, null, { revoked: false, completed: false }, 0n),
        },
      ];
    });
  }, [account, relayRecords]);

  const dialogue = useMemo(
    () =>
      connectDialogue({
        account,
        providerAvailable,
        isRobinhoodChain,
        loading: loading || (account !== null && loaded !== account.toLowerCase()),
        capsules,
        authorizations,
        proposedAgent: agent,
        aliases,
        selection,
        mcpSnippet: MCP_SNIPPET,
        explorerTx: explorerTransaction,
        agentConfigured,
        composing,
        proposal,
        refusal,
      }),
    [
      account,
      providerAvailable,
      isRobinhoodChain,
      loading,
      loaded,
      capsules,
      authorizations,
      agent,
      aliases,
      selection,
      agentConfigured,
      composing,
      proposal,
      refusal,
    ],
  );

  const onChip = useCallback(
    (chip: TranscriptChip): void => {
      const [kind, value] = chip.value.split(":");
      switch (kind) {
        case CONNECT_CHIPS.connectWallet:
          void connect().catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : "The wallet refused the connection."),
          );
          return;
        case CONNECT_CHIPS.switchChain:
          void switchToRobinhood().catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : "The wallet refused the network switch."),
          );
          return;
        case CONNECT_CHIPS.zapIn:
          window.location.href = "/zap?view=sign&route=robinhood-v4-weth-zaps";
          return;
        case CONNECT_CHIPS.compose:
          window.location.href = "/zap?view=design";
          return;
        case CONNECT_CHIPS.describe:
          setSelection({ describing: true });
          setProposal(null);
          setRefusal(null);
          setError("");
          return;
        case CONNECT_CHIPS.capsule:
          setSelection({ zap: getAddress(value) });
          return;
        case CONNECT_CHIPS.mode:
          // "Both at once" is a refusal, not a selection: one signature binds one
          // schedule OR one price condition, and the capsule has no kind that is
          // both. Saying so is more useful than hiding the option.
          if (value === "both") {
            setError(
              "One signature binds one authorization: a cadence or a price condition, never both. Sign two — they are independent and revocable separately.",
            );
            return;
          }
          setSelection((current) => ({ ...current, mode: value as ConnectMode }));
          return;
        case CONNECT_CHIPS.access:
          setSelection((current) => ({ ...current, access: value as ConnectAccess }));
          return;
        case CONNECT_CHIPS.restart:
          setSelection({});
          setProposal(null);
          setRefusal(null);
          setError("");
          return;
        default:
          return;
      }
    },
    [connect, switchToRobinhood],
  );

  const handoff =
    dialogue.stage === "ready" && dialogue.handoffReady ? connectHandoff(selection, agent) : null;

  return (
    <main className={styles.screen} id="main" data-screen-label="Connect">
      <div className={styles.hero}>
        <div>
          <span className={styles.heroEyebrow}>CONNECT AN AGENT</span>
          <h1 className={styles.heroTitle}>Give an agent the trigger. Never the authority.</h1>
          <p className={styles.heroLede}>
            An agent is connected to a Zap when you sign an intent naming its address. The capsule
            reverts for anyone else. There is no key to hand over and no credential to steal.
          </p>
        </div>
      </div>

      <div className={styles.split}>
        <section className={styles.dialogue} aria-labelledby="connect-dialogue-heading">
          <h2 className={styles.paneTitle} id="connect-dialogue-heading">
            Pair a capsule
          </h2>
          <Transcript
            label="Agent pairing"
            messages={dialogue.messages}
            status={error ? "error" : dialogue.status}
            statusNote={error || undefined}
            composer={dialogue.composer}
            onChip={onChip}
            onSubmit={(text) => void compose(text)}
          />
          {relayHasOlder ? (
            <p className={styles.sideNote} role="status">
              Showing the newest 50 relay authorizations for this wallet. Older records remain
              available through the paginated relay API.
            </p>
          ) : null}
          {handoff ? (
            <a className={`btn btnPrimary ${styles.handoff}`} href={handoff}>
              Sign the authorization →
            </a>
          ) : null}
        </section>

        <aside className={styles.side}>
          <section aria-labelledby="connect-cannot-heading">
            <h2 className={styles.paneTitle} id="connect-cannot-heading">
              What an agent can never do
            </h2>
            <ul className={styles.cannot}>
              {AGENT_CANNOT.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className={styles.sideNote}>
              Every line is enforced by the capsule, not by this app. A fully compromised agent can
              submit a run you already signed for, or refuse to submit one. That is the whole blast
              radius.
            </p>
          </section>

          {OPENZAPS_AGENT_KIT_PUBLISHED ? (
            <section aria-labelledby="connect-mcp-heading">
              <h2 className={styles.paneTitle} id="connect-mcp-heading">
                Point your agent at OpenZaps
              </h2>
              <p className={styles.sideNote}>
                Add this to your MCP client. It exposes read-only tools — capsules, policies,
                authorizations, and simulations. It holds no key and cannot sign or broadcast.
              </p>
              <pre className={styles.snippet}>{MCP_SNIPPET}</pre>
              <CopyButton value={MCP_SNIPPET} label="Copy MCP config" className={styles.copy} />
              <p className={styles.sideNote}>
                Then ask your agent for its executor address — <code className="mono">agent_identity</code> —
                and pin that address when you sign.
              </p>
            </section>
          ) : (
            <section aria-labelledby="connect-mcp-heading">
              <h2 className={styles.paneTitle} id="connect-mcp-heading">
                Agent Kit release
              </h2>
              <p className={styles.sideNote}>
                The read-only SDK and MCP packages are release-ready, but the install command stays hidden until the
                scoped npm packages are published. Connecting an existing executor address still works normally.
              </p>
            </section>
          )}

          <section aria-labelledby="connect-public-heading">
            <h2 className={styles.paneTitle} id="connect-public-heading">
              Pinning is public
            </h2>
            <p className={styles.sideNote}>
              The executor you pin is inside your signed intent and in the chain&rsquo;s logs. Anyone
              can see which agent runs your Zap. Nothing about that is private, and nothing here
              stores it separately.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}

const MCP_SNIPPET = mcpClientSnippet();

function parseRelayIntent(record: RelayRecord): ParsedAutomationIntent | null {
  return parseAutomationIntent(
    JSON.stringify({ kind: record.kind, intent: record.intent, signature: record.signature }),
  );
}

function readAliases(owner: Address): AgentAliases {
  try {
    // The key comes from the module that owns it — hardcoding the string here
    // would leave Connect reading a key nothing writes the moment it changes,
    // and silently, since a missing alias is never load-bearing.
    return parseAgentAliases(window.localStorage.getItem(agentAliasStorageKey(owner)));
  } catch {
    return {};
  }
}
