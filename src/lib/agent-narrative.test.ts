import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { narrateAgents, type NarrativeAuthorization, type NarrativeInput } from "@/lib/agent-narrative";
import { OPEN_EXECUTOR } from "@/lib/automate";
import type { ParsedAutomationIntent } from "@/lib/automation-records";
import type { AutomationLifecycle, AutomationLifecycleView } from "@/lib/automation-status";
import type { WalletActivityEntry } from "@/lib/profile";
import type { RelaySubmission } from "@/lib/relay";
import type { TranscriptMessage } from "@/lib/transcript";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const OTHER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;
const ZAP_A = "0x9941dD72373429C36F82D888dbcbab080038f033" as const;
const ZAP_B = "0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07" as const;
const TX = `0x${"11".repeat(32)}` as const;

const explorerTx = (hash: `0x${string}`): string => `https://example.test/tx/${hash}`;

function intent(executor: Address, authorizationId: bigint, zap: Address = ZAP_A): ParsedAutomationIntent {
  return {
    submission: { kind: "recurring", intent: {}, signature: "0x" } as unknown as RelaySubmission,
    kind: "recurring",
    mode: "recurring",
    zap,
    authorizationId,
    validAfter: 0n,
    deadline: 0n,
    recipient: OWNER,
    executor,
    outAsset: ZAP_B,
    interval: 86_400n,
    maxRuns: 10,
    thresholdBps: null,
    above: null,
    priceSource: null,
    baselinePriceX96: null,
  };
}

function state(lifecycle: AutomationLifecycle): AutomationLifecycleView {
  return { lifecycle, label: lifecycle, detail: "", cancelable: false };
}

function authorization(
  executor: Address,
  id: bigint,
  lifecycle: AutomationLifecycle,
  zap: Address = ZAP_A,
): NarrativeAuthorization {
  return { key: `${zap.toLowerCase()}:${id}`, zap, intent: intent(executor, id, zap), state: state(lifecycle) };
}

function run(authorizationId: string, runNumber: number, actor: Address | null): WalletActivityEntry {
  return {
    id: `${authorizationId}-${runNumber}`,
    kind: "automated",
    status: "confirmed",
    zap: ZAP_A,
    lineage: "v3.1",
    txHash: TX,
    blockNumber: "100",
    logIndex: runNumber,
    timestamp: 1_700_000_000 + runNumber,
    actor,
    amount: "1.5",
    assetSymbol: "0xZAPS",
    detail: "",
    authorizationId,
    run: runNumber,
    automationKind: "recurring",
  };
}

function base(overrides: Partial<NarrativeInput> = {}): NarrativeInput {
  return { owner: OWNER, authorizations: [], activity: [], explorerTx, ...overrides };
}

function texts(messages: readonly TranscriptMessage[]): string[] {
  return messages.flatMap((message) => (message.body.kind === "text" ? [message.body.text] : []));
}

describe("narrateAgents", () => {
  it("says so plainly when nothing is signed", () => {
    const messages = narrateAgents(base());
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("agent");
    expect(texts(messages)[0]).toContain("No signed authorization");
  });

  it("ignores an authorization with no signed artifact rather than guessing at a submitter", () => {
    const messages = narrateAgents(
      base({ authorizations: [{ key: "draft", zap: ZAP_A, intent: null, state: state("draft") }] }),
    );
    expect(messages).toHaveLength(1);
    expect(texts(messages)[0]).toContain("No signed authorization");
  });

  it("groups authorizations by submitter and leads with the pinned count", () => {
    const messages = narrateAgents(
      base({
        authorizations: [
          authorization(AGENT, 1n, "waiting"),
          authorization(AGENT, 2n, "waiting", ZAP_B),
          authorization(OPEN_EXECUTOR, 3n, "waiting"),
        ],
      }),
    );

    expect(texts(messages)[0]).toContain("1 agent can submit runs for you, across 2 capsules");
  });

  it("orders pinned agents ahead of owner-only and open", () => {
    const messages = narrateAgents(
      base({
        authorizations: [
          authorization(OPEN_EXECUTOR, 1n, "waiting"),
          authorization(OWNER, 2n, "waiting"),
          authorization(AGENT, 3n, "waiting"),
        ],
      }),
    );

    const submitters = messages.flatMap((message) =>
      message.body.kind === "facts" ? [message.body.rows[0].value] : [],
    );
    expect(submitters[0]).toContain(AGENT);
    expect(submitters[1]).toContain("You only");
    expect(submitters[2]).toContain("Anyone");
  });

  it("separates owner-only from a pinned agent", () => {
    const messages = narrateAgents(base({ authorizations: [authorization(OWNER, 1n, "waiting")] }));
    expect(texts(messages)[0]).toContain("No agent is pinned");
  });

  it("renders an alias alongside the address, never instead of it", () => {
    const messages = narrateAgents(
      base({ authorizations: [authorization(AGENT, 1n, "waiting")], aliases: { [AGENT.toLowerCase()]: "Claude" } }),
    );
    const facts = messages.find((message) => message.body.kind === "facts");
    expect(facts?.body.kind === "facts" && facts.body.rows[0].value).toBe("Claude · 0x3C44…93BC");
  });

  it("attaches confirmed runs with a receipt link", () => {
    const messages = narrateAgents(
      base({ authorizations: [authorization(AGENT, 1n, "waiting")], activity: [run("1", 1, AGENT)] }),
    );

    const chain = messages.find((message) => message.role === "chain");
    expect(chain?.body.kind === "text" && chain.body.text).toBe("Run 1 executed — 1.5 0xZAPS submitted by 0x3C44…93BC.");
    expect(chain?.evidence).toEqual({ label: "receipt", href: explorerTx(TX) });
    expect(chain?.at).toBe(new Date(1_700_000_001_000).toISOString());
  });

  it("does not attribute another authorization's runs to this agent", () => {
    const messages = narrateAgents(
      base({ authorizations: [authorization(AGENT, 1n, "waiting")], activity: [run("999", 1, AGENT)] }),
    );
    expect(messages.filter((message) => message.role === "chain")).toHaveLength(0);
  });

  it("summarizes the tail rather than listing every run", () => {
    const activity = [1, 2, 3, 4, 5, 6].map((i) => run("1", i, AGENT));
    const messages = narrateAgents(base({ authorizations: [authorization(AGENT, 1n, "waiting")], activity, runLimit: 2 }));

    expect(messages.filter((message) => message.evidence)).toHaveLength(2);
    expect(texts(messages).some((text) => text === "4 earlier runs not shown.")).toBe(true);
  });

  it("names the addresses that raced an open authorization", () => {
    const messages = narrateAgents(
      base({
        authorizations: [authorization(OPEN_EXECUTOR, 1n, "waiting")],
        activity: [run("1", 1, OTHER), run("1", 2, OTHER), run("1", 3, AGENT)],
      }),
    );

    const text = texts(messages).find((line) => line.includes("submitted these runs"));
    expect(text).toContain("2 addresses");
    expect(text).toContain("0x90F7…b906");
    expect(text).toContain("0x3C44…93BC");
  });

  it("does not list the owner as a competing submitter", () => {
    const messages = narrateAgents(
      base({ authorizations: [authorization(OPEN_EXECUTOR, 1n, "waiting")], activity: [run("1", 1, OWNER)] }),
    );
    expect(texts(messages).some((line) => line.includes("submitted these runs"))).toBe(false);
  });

  it("emits exactly one forward-looking message per agent, always last in its block", () => {
    const messages = narrateAgents(
      base({
        authorizations: [authorization(AGENT, 1n, "waiting"), authorization(OWNER, 2n, "due")],
        activity: [run("1", 1, AGENT)],
      }),
    );

    const forward = texts(messages).filter(
      (text) =>
        text.includes("may be submitted now") ||
        text.includes("Nothing is due") ||
        text.includes("Nothing more will happen") ||
        text.includes("cannot be computed"),
    );
    expect(forward).toHaveLength(2);

    // The pinned agent's block ends with its own forward look, before the next
    // group's facts card opens.
    const roles = messages.map((message) => `${message.role}:${message.body.kind}`);
    expect(roles).toEqual([
      "agent:text",
      "capsule:facts",
      "chain:text",
      "capsule:text",
      "capsule:facts",
      "capsule:text",
    ]);
  });

  describe("the four forward-looking forms, and no fifth", () => {
    it("reports work that is ready", () => {
      const messages = narrateAgents(
        base({ authorizations: [authorization(AGENT, 1n, "due"), authorization(AGENT, 2n, "armed")] }),
      );
      expect(texts(messages)).toContain("2 authorizations may be submitted now.");
    });

    it("prefers ready over waiting when both exist", () => {
      const messages = narrateAgents(
        base({ authorizations: [authorization(AGENT, 1n, "due"), authorization(AGENT, 2n, "waiting")] }),
      );
      expect(texts(messages)).toContain("1 authorization may be submitted now.");
    });

    it("reports waiting", () => {
      const messages = narrateAgents(
        base({ authorizations: [authorization(AGENT, 1n, "waiting"), authorization(AGENT, 2n, "scheduled")] }),
      );
      expect(texts(messages)).toContain("Nothing is due. 2 authorizations still waiting on cadence or price.");
    });

    it("closes out a group whose authorizations are all terminal", () => {
      const messages = narrateAgents(
        base({ authorizations: [authorization(AGENT, 1n, "completed"), authorization(AGENT, 2n, "revoked")] }),
      );
      expect(texts(messages)).toContain("Nothing more will happen here: every authorization is completed or revoked.");
    });

    it("refuses to guess when the chain read failed", () => {
      const messages = narrateAgents(base({ authorizations: [authorization(AGENT, 1n, "unavailable")] }));
      expect(texts(messages)).toContain("The next run cannot be computed from what is onchain right now.");
    });
  });

  it("states what a compromised agent still cannot do", () => {
    const messages = narrateAgents(base({ authorizations: [authorization(AGENT, 1n, "waiting")] }));
    const facts = messages.find((message) => message.body.kind === "facts");
    const cannot = facts?.body.kind === "facts" && facts.body.rows.find((row) => row.key === "cannot");
    expect(cannot && cannot.value).toContain("run early, twice, or past the end");
  });

  it("gives every message a unique id", () => {
    const messages = narrateAgents(
      base({
        authorizations: [authorization(AGENT, 1n, "due"), authorization(OPEN_EXECUTOR, 2n, "waiting")],
        activity: [run("1", 1, AGENT)],
      }),
    );
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
  });

  it("is pure — same input, same output, no clock", () => {
    const input = base({ authorizations: [authorization(AGENT, 1n, "due")], activity: [run("1", 1, AGENT)] });
    expect(narrateAgents(input)).toEqual(narrateAgents(input));
  });
});
