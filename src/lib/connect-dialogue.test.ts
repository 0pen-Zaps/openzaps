import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { readAutomationHandoff } from "@/lib/automate";
import type { NarrativeAuthorization } from "@/lib/agent-narrative";
import type { ParsedAutomationIntent } from "@/lib/automation-records";
import {
  AGENT_CANNOT,
  connectDialogue,
  connectHandoff,
  type ConnectCapsule,
  type ConnectDialogueInput,
} from "@/lib/connect-dialogue";
import type { RelaySubmission } from "@/lib/relay";
import { resolveZapView } from "@/lib/zap-view";

const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const AGENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const ZAP = "0x9941dD72373429C36F82D888dbcbab080038f033" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

const capsule: ConnectCapsule = { address: ZAP, lineage: "v3.1", automatedRunCount: 3 };

function authorization(executor: Address): NarrativeAuthorization {
  const intent: ParsedAutomationIntent = {
    submission: { kind: "recurring", intent: {}, signature: "0x" } as unknown as RelaySubmission,
    kind: "recurring",
    mode: "recurring",
    zap: ZAP,
    authorizationId: 1n,
    validAfter: 0n,
    deadline: 0n,
    recipient: OWNER,
    executor,
    outAsset: ZAP,
    interval: 86_400n,
    maxRuns: 10,
    thresholdBps: null,
    above: null,
    priceSource: null,
    baselinePriceX96: null,
  };
  return { key: `${ZAP.toLowerCase()}:1`, zap: ZAP, intent, state: { lifecycle: "waiting", label: "", detail: "", cancelable: true } };
}

function input(overrides: Partial<ConnectDialogueInput> = {}): ConnectDialogueInput {
  return {
    account: OWNER,
    providerAvailable: true,
    isRobinhoodChain: true,
    loading: false,
    capsules: [capsule],
    authorizations: [],
    proposedAgent: null,
    selection: {},
    mcpSnippet: "{}",
    explorerTx: (hash) => `https://example.test/tx/${hash}`,
    ...overrides,
  };
}

const chipIds = (result: ReturnType<typeof connectDialogue>): string[] =>
  result.composer.mode === "chips" || result.composer.mode === "text"
    ? (result.composer.chips ?? []).map((chip) => chip.id)
    : [];

describe("the stage ladder", () => {
  it("asks for a wallet first, and offers nothing to click without one", () => {
    expect(connectDialogue(input({ account: null })).stage).toBe("no-wallet");
    expect(chipIds(connectDialogue(input({ account: null })))).toEqual(["connect-wallet"]);

    const noProvider = connectDialogue(input({ account: null, providerAvailable: false }));
    expect(noProvider.composer.mode).toBe("none");
  });

  it("asks for the right chain before reading anything", () => {
    const result = connectDialogue(input({ isRobinhoodChain: false }));
    expect(result.stage).toBe("wrong-chain");
    expect(chipIds(result)).toEqual(["switch-chain"]);
  });

  it("does not claim zero capsules while still loading", () => {
    // "You have no capsules" and "I have not looked yet" are different claims.
    const result = connectDialogue(input({ loading: true, capsules: [] }));
    expect(result.stage).toBe("loading");
    expect(result.status).toBe("thinking");
  });

  it("sends someone with no capsules to make one", () => {
    const result = connectDialogue(input({ capsules: [] }));
    expect(result.stage).toBe("no-capsules");
    expect(chipIds(result)).toEqual(["zap-in", "compose"]);
  });

  it("walks capsule → mode → access → ready", () => {
    expect(connectDialogue(input()).stage).toBe("choose-capsule");
    expect(connectDialogue(input({ selection: { zap: ZAP } })).stage).toBe("choose-mode");
    expect(connectDialogue(input({ selection: { zap: ZAP, mode: "recurring" } })).stage).toBe("choose-access");
    expect(connectDialogue(input({ selection: { zap: ZAP, mode: "recurring", access: "anyone" } })).stage).toBe("ready");
  });

  it("shows the narrator once an agent is already pinned", () => {
    const result = connectDialogue(input({ authorizations: [authorization(AGENT)] }));
    expect(result.stage).toBe("connected");
  });

  it("does not treat an open authorization as a connected agent", () => {
    // executor == 0x0 means "anyone may submit", which is the absence of an agent.
    const result = connectDialogue(input({ authorizations: [authorization(ZERO)] }));
    expect(result.stage).toBe("choose-capsule");
  });
});

describe("what it says", () => {
  it("offers 'both at once' as a refusal chip, not a capability", () => {
    const result = connectDialogue(input({ selection: { zap: ZAP } }));
    const both = result.composer.mode === "chips" && result.composer.chips.find((c) => c.id.endsWith(":both"));
    expect(both && both.hint).toContain("refused");
  });

  it("states what the agent cannot do, verbatim, at the terminal step", () => {
    const result = connectDialogue(input({ selection: { zap: ZAP, mode: "recurring", access: "pinned" } }));
    const refusal = result.messages.find((message) => message.body.kind === "refusal");
    expect(refusal?.tone).toBe("verbatim");
    expect(refusal?.body.kind === "refusal" && refusal.body.refuses).toEqual([...AGENT_CANNOT]);
  });

  it("says plainly that nothing is stored", () => {
    const result = connectDialogue(input({ selection: { zap: ZAP, mode: "recurring", access: "anyone" } }));
    const facts = result.messages.flatMap((m) => (m.body.kind === "facts" ? m.body.rows : []));
    expect(facts.find((row) => row.key === "stored")?.value).toContain("Nothing");
  });

  it("names the proposed agent when a ?agent= link brought one", () => {
    const result = connectDialogue(input({ selection: { zap: ZAP, mode: "recurring" }, proposedAgent: AGENT }));
    const pin = result.composer.mode === "chips" && result.composer.chips.find((c) => c.id.endsWith(":pinned"));
    expect(pin && pin.label).toBe("Pin 0x3C44…93BC");
  });

  it("warns that a pinned agent going offline stalls the series", () => {
    const result = connectDialogue(input({ selection: { zap: ZAP, mode: "recurring" } }));
    const pin = result.composer.mode === "chips" && result.composer.chips.find((c) => c.id.endsWith(":pinned"));
    expect(pin && pin.hint).toContain("stalls");
  });

  it("gives every message a unique id at every stage", () => {
    for (const selection of [{}, { zap: ZAP }, { zap: ZAP, mode: "recurring" as const }, { zap: ZAP, mode: "recurring" as const, access: "pinned" as const }]) {
      const result = connectDialogue(input({ selection }));
      expect(new Set(result.messages.map((m) => m.id)).size).toBe(result.messages.length);
    }
  });

  it("is pure — same input, same output", () => {
    const shared = input({ selection: { zap: ZAP, mode: "trigger", access: "pinned" }, proposedAgent: AGENT });
    expect(connectDialogue(shared)).toEqual(connectDialogue(shared));
  });
});

describe("the terminal handoff", () => {
  it("is withheld when the person chose to pin but no address is known", () => {
    // The handoff URL cannot express "pinned, address pending": ExecutorAccess
    // has no such member, so it would carry executor=anyone. Offering the link
    // would land them on a form pre-selected to the opposite of their choice,
    // and a signature made without noticing produces an OPEN authorization.
    const result = connectDialogue(
      input({ selection: { zap: ZAP, mode: "recurring", access: "pinned" }, proposedAgent: null }),
    );
    expect(result.stage).toBe("ready");
    expect(result.handoffReady).toBe(false);
  });

  it("is offered once the pinned address is known", () => {
    const result = connectDialogue(
      input({ selection: { zap: ZAP, mode: "recurring", access: "pinned" }, proposedAgent: AGENT }),
    );
    expect(result.handoffReady).toBe(true);
  });

  it("is offered for the choices that need no address", () => {
    for (const access of ["anyone", "owner-only"] as const) {
      const result = connectDialogue(input({ selection: { zap: ZAP, mode: "recurring", access } }));
      expect(result.handoffReady, access).toBe(true);
    }
  });
});

describe("the describe-it-in-words path", () => {
  it("is hidden when no model is configured", () => {
    // Hidden, not broken: a text box that 503s on submit is worse than no box.
    const withoutModel = connectDialogue(input({ capsules: [] }));
    expect(chipIds(withoutModel)).toEqual(["zap-in", "compose"]);

    const withModel = connectDialogue(input({ capsules: [], agentConfigured: true }));
    expect(chipIds(withModel)).toContain("describe");
  });

  it("is offered alongside existing capsules too", () => {
    const result = connectDialogue(input({ agentConfigured: true }));
    expect(result.stage).toBe("choose-capsule");
    expect(chipIds(result)).toContain("describe");
  });

  it("opens a bounded text composer", () => {
    const result = connectDialogue(input({ selection: { describing: true }, agentConfigured: true }));
    expect(result.stage).toBe("describing");
    expect(result.composer.mode).toBe("text");
    if (result.composer.mode !== "text") return;
    expect(result.composer.maxLength).toBe(400);
  });

  it("reports compiling while the request is in flight", () => {
    const result = connectDialogue(input({ selection: { describing: true }, composing: true }));
    expect(result.status).toBe("compiling");
    expect(result.composer.mode === "text" && result.composer.busy).toBe(true);
  });

  it("renders a returned plan as a capsule message, not an agent one", () => {
    // The plan's numbers came from the compiler. Attributing them to the agent
    // would make a proposal look like a guarantee.
    const plan = { status: "pass", steps: ["a"], checks: [], hash: "0x0", gas: 1, guardScore: 100, refuses: [], chain: [], token: "t", handoff: null } as never;
    const result = connectDialogue(
      input({ selection: { describing: true }, proposal: { plan, rationale: "Because." } }),
    );

    const planMessage = result.messages.find((message) => message.body.kind === "plan");
    expect(planMessage?.role).toBe("capsule");
    expect(result.messages.some((m) => m.body.kind === "text" && m.body.text === "Because.")).toBe(true);
  });

  it("renders a refusal verbatim", () => {
    const result = connectDialogue(
      input({
        selection: { describing: true },
        refusal: { reason: "That design will not compile.", issues: ["A source must come first."] },
      }),
    );

    const refusal = result.messages.find((message) => message.body.kind === "refusal");
    expect(refusal?.tone).toBe("verbatim");
    expect(refusal?.body.kind === "refusal" && refusal.body.refuses).toEqual(["A source must come first."]);
  });

  it("offers a way back out", () => {
    const result = connectDialogue(input({ selection: { describing: true } }));
    expect(chipIds(result)).toContain("restart");
  });
});

describe("connectHandoff", () => {
  it("produces a URL the automate console accepts", () => {
    // The whole point of reusing the console's params: if this drifts, the
    // handoff silently lands on a default form instead of the chosen terms.
    for (const mode of ["recurring", "trigger"] as const) {
      const href = connectHandoff({ zap: ZAP, mode, access: "anyone" }, null);
      const params = new URLSearchParams(href.split("?")[1]);
      const preset = readAutomationHandoff(params);
      expect(preset, mode).not.toBeNull();
      expect(preset?.mode).toBe(mode);
    }
  });

  it("resolves to the automate view, not the sign view", () => {
    // ?view=automate&src=build is exactly the collision the view resolver has to
    // get right: src=build alone means "sign".
    const href = connectHandoff({ zap: ZAP, mode: "recurring", access: "anyone" }, null);
    expect(resolveZapView(new URLSearchParams(href.split("?")[1]))).toBe("automate");
  });

  it("carries owner-only through as an execution-policy param", () => {
    const href = connectHandoff({ zap: ZAP, mode: "recurring", access: "owner-only" }, null);
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("executor")).toBe("owner");
    expect(readAutomationHandoff(params)?.executionPolicy.executorAccess).toBe("owner-only");
  });

  it("carries a pinned agent only when the access is actually pinned", () => {
    expect(connectHandoff({ zap: ZAP, mode: "recurring", access: "pinned" }, AGENT)).toContain(`agent=${AGENT}`);
    expect(connectHandoff({ zap: ZAP, mode: "recurring", access: "anyone" }, AGENT)).not.toContain("agent=");
    expect(connectHandoff({ zap: ZAP, mode: "recurring", access: "pinned" }, null)).not.toContain("agent=");
  });

  it("keeps a pinned agent out of the signed execution policy", () => {
    // Pinning is expressed in the intent's executor field at signing, not in the
    // policy's open/owner-only bit. Conflating them would sign the wrong thing.
    const params = new URLSearchParams(connectHandoff({ zap: ZAP, mode: "recurring", access: "pinned" }, AGENT).split("?")[1]);
    expect(params.get("executor")).toBe("anyone");
  });
});
