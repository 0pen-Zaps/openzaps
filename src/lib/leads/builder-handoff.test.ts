import { describe, expect, it } from "vitest";

import {
  makeNode,
  type ChainNode,
  type CompiledZap,
} from "@/lib/blocks";
import {
  builderLeadRequestHandoff,
  consumeBuilderLeadRequestDraft,
  consumeBuilderLeadRequestDraftInBrowser,
  storeBuilderLeadRequestDraft,
  storeBuilderLeadRequestDraftInBrowser,
} from "@/lib/leads/builder-handoff";

const PRIVATE_ADDRESS = "0x1111111111111111111111111111111111111111";
const PRIVATE_UID = "private-runtime-node-id";
const PRIVATE_TEXT = "arbitrary private operator note";
const PRIVATE_FINGERPRINT = "deadbeefcafebabefeedface";
const PRIVATE_AMOUNT = "987654321.123456789";

function compiled(status: CompiledZap["status"]): CompiledZap {
  return {
    status,
    joints: [],
    issues: [{ level: "warn", message: PRIVATE_TEXT, uid: PRIVATE_UID }],
    checks: [],
    hash: PRIVATE_FINGERPRINT,
    gas: 123_456,
    guardScore: 0,
    missingGuards: [{ guardId: "private-guard", risk: PRIVATE_TEXT }],
    steps: [PRIVATE_TEXT, PRIVATE_ADDRESS, PRIVATE_AMOUNT],
    outputShape: "token",
  };
}

function requestDraft(chain: readonly ChainNode[], status: CompiledZap["status"]) {
  return builderLeadRequestHandoff(chain, compiled(status)).draft;
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  };
}

describe("builder lead handoff", () => {
  it("builds a deterministic bounded request from catalog-owned values", () => {
    const chain = [
      makeNode("wallet-balance", PRIVATE_UID, {
        asset: "WETH",
        amount: PRIVATE_AMOUNT,
        unknown: PRIVATE_TEXT,
        wallet: PRIVATE_ADDRESS,
      }),
      makeNode("swap", "swap-secret", {
        into: "0xZAPS",
        venue: "Uniswap v4",
        amount: PRIVATE_AMOUNT,
        note: PRIVATE_TEXT,
      }),
      makeNode("send", "recipient-secret", {
        recipient: "custom address",
        address: PRIVATE_ADDRESS,
      }),
    ];

    const handoff = builderLeadRequestHandoff(chain, compiled("pass"));
    const repeatedHandoff = builderLeadRequestHandoff(chain, compiled("pass"));
    const url = new URL(handoff.href, "https://www.0xzaps.com");
    const { workflow, protocolsAssets } = handoff.draft;

    expect(repeatedHandoff).toEqual(handoff);
    expect(url.pathname).toBe("/request-a-zap");
    expect([...url.searchParams.keys()]).toEqual(["entry_point"]);
    expect(url.searchParams.get("entry_point")).toBe("builder_review");
    expect(handoff.href).not.toContain("workflow");
    expect(handoff.href).not.toContain("protocolsAssets");
    expect(workflow).toContain("Wallet balance → Swap → Send to recipient");
    expect(workflow).toContain("compiler verdict is pass");
    expect(workflow).toContain("complete route still requires deployability review");
    expect(protocolsAssets).toContain("WETH");
    expect(protocolsAssets).toContain("0xZAPS");
    expect(protocolsAssets).toContain("Uniswap v4");
    expect(protocolsAssets).toContain("Catalog protocols:");
    expect(workflow.length).toBeLessThanOrEqual(4_000);
    expect(protocolsAssets.length).toBeLessThanOrEqual(2_000);

    for (const privateValue of [
      PRIVATE_UID,
      PRIVATE_TEXT,
      PRIVATE_FINGERPRINT,
      PRIVATE_AMOUNT,
      PRIVATE_ADDRESS,
      "custom address",
    ]) {
      expect(`${workflow}\n${protocolsAssets}`).not.toContain(privateValue);
    }
    expect(`${workflow}\n${protocolsAssets}`).not.toMatch(/0x[a-f0-9]{40,64}/iu);
  });

  it("preserves a privacy-reduced first touch separately from the builder entry point", () => {
    const url = new URL(
      builderLeadRequestHandoff(
        [makeNode("wallet-balance", PRIVATE_UID)],
        compiled("warn"),
        {
          source: "x",
          medium: "social",
          campaign: "product_update",
          content: "feed_update",
        },
      ).href,
      "https://www.0xzaps.com",
    );

    expect(url.searchParams.get("entry_point")).toBe("builder_review");
    expect(url.searchParams.get("utm_source")).toBe("x");
    expect(url.searchParams.get("utm_medium")).toBe("social");
    expect(url.searchParams.get("utm_campaign")).toBe("product_update");
    expect(url.searchParams.get("utm_content")).toBe("feed_update");
  });

  it("drops acquisition values that bypass the controlled first-touch decoder", () => {
    const url = new URL(
      builderLeadRequestHandoff(
        [makeNode("wallet-balance", PRIVATE_UID)],
        compiled("warn"),
        {
          source: "https://private.example",
          medium: "private-channel",
          campaign: "person@example.com",
          content: PRIVATE_TEXT,
        },
      ).href,
      "https://www.0xzaps.com",
    );

    expect(url.searchParams.get("entry_point")).toBe("builder_review");
    expect(url.searchParams.has("utm_source")).toBe(false);
    expect(url.searchParams.has("utm_medium")).toBe(false);
    expect(url.searchParams.has("utm_campaign")).toBe(false);
    expect(url.searchParams.has("utm_content")).toBe(false);
  });

  it.each(["pass", "warn", "block"] as const)(
    "carries the coarse %s compiler state without compiler internals",
    (status) => {
      const { workflow } = requestDraft(
        [makeNode("wallet-balance", PRIVATE_UID)],
        status,
      );

      expect(workflow).toContain(`compiler verdict is ${status}`);
      expect(workflow).not.toContain(PRIVATE_FINGERPRINT);
      expect(workflow).not.toContain(PRIVATE_TEXT);
    },
  );

  it("labels non-live catalog blocks as design-only", () => {
    const { workflow, protocolsAssets } = requestDraft(
      [
        makeNode("lp-position", PRIVATE_UID, {
          asset: "ozRANGE",
          amount: PRIVATE_AMOUNT,
        }),
        makeNode("hold-lp", "hold-secret"),
      ],
      "warn",
    );
    expect(workflow).toContain("design-only until reviewed");
    expect(protocolsAssets).toContain("ozRANGE");
    expect(protocolsAssets).not.toContain(PRIVATE_AMOUNT);
  });

  it("names only catalog-backed protocols for protocol actions", () => {
    const { protocolsAssets } = requestDraft(
      [
        makeNode("wallet-balance", PRIVATE_UID, { asset: "USDG" }),
        makeNode("supply", "supply-secret", { market: "Morpho" }),
      ],
      "warn",
    );
    expect(protocolsAssets).toContain("Catalog protocols: Morpho");
    expect(protocolsAssets).toContain("Selected catalog assets/context: USDG, Morpho");
  });

  it("does not apply protocol defaults to stale catalog selections", () => {
    const { protocolsAssets } = requestDraft(
      [
        makeNode("swap", "stale-swap", { venue: "Removed venue" }),
        makeNode("supply", "stale-supply", { market: "Removed market" }),
      ],
      "block",
    );
    expect(protocolsAssets).toContain("Catalog protocols: none");
    expect(protocolsAssets).not.toContain("Uniswap v4");
    expect(protocolsAssets).not.toContain("Morpho");
  });

  it("drops unknown blocks, unknown params, invalid select values, and arbitrary text", () => {
    const chain: ChainNode[] = [
      {
        uid: PRIVATE_UID,
        blockId: "private-unknown-block",
        params: {
          asset: PRIVATE_ADDRESS,
          amount: PRIVATE_AMOUNT,
          note: PRIVATE_TEXT,
        },
      },
      makeNode("swap", "known", {
        into: PRIVATE_TEXT,
        venue: "private venue",
        amount: PRIVATE_AMOUNT,
      }),
    ];
    const draft = requestDraft(chain, "block");
    const values = `${draft.workflow}\n${draft.protocolsAssets}`;

    expect(values).toContain("Recognized sequence: Swap");
    expect(values).not.toContain("private-unknown-block");
    expect(values).not.toContain(PRIVATE_UID);
    expect(values).not.toContain(PRIVATE_TEXT);
    expect(values).not.toContain("private venue");
    expect(values).not.toContain(PRIVATE_ADDRESS);
    expect(values).not.toContain(PRIVATE_AMOUNT);
    expect(values).toContain("Catalog protocols: none");
  });

  it("keeps destination fields bounded for the maximum shared-chain shape", () => {
    const chain = Array.from({ length: 64 }, (_, index) =>
      makeNode("swap", `private-${index}`, {
        into: index % 2 === 0 ? "0xZAPS" : "WETH",
        venue: "Uniswap v4",
        amount: PRIVATE_AMOUNT,
      }));
    const handoff = builderLeadRequestHandoff(chain, compiled("block"));

    expect(handoff.draft.workflow.length).toBeLessThanOrEqual(1_200);
    expect(handoff.draft.protocolsAssets.length).toBeLessThanOrEqual(800);
    expect(handoff.href.length).toBeLessThan(500);
    expect(JSON.stringify(handoff)).not.toContain(PRIVATE_AMOUNT);
    expect(handoff.draft.workflow).toContain("44 more catalog blocks");
  });

  it("stores and consumes the safe prefill exactly once in the current tab", () => {
    const { storage, values } = memoryStorage();
    const draft = requestDraft([makeNode("wallet-balance", PRIVATE_UID)], "warn");

    expect(storeBuilderLeadRequestDraft(storage, draft)).toBe(true);
    expect(values.size).toBe(1);
    expect(consumeBuilderLeadRequestDraft(storage)).toEqual(draft);
    expect(values.size).toBe(0);
    expect(consumeBuilderLeadRequestDraft(storage)).toBeNull();
  });

  it("removes and rejects malformed or expanded stored prefills", () => {
    const { storage, values } = memoryStorage();
    const draft = requestDraft([makeNode("wallet-balance", PRIVATE_UID)], "warn");

    expect(storeBuilderLeadRequestDraft(storage, draft)).toBe(true);
    const [key] = values.keys();
    values.set(key, JSON.stringify({ version: 1, ...draft, secret: PRIVATE_TEXT }));

    expect(consumeBuilderLeadRequestDraft(storage)).toBeNull();
    expect(values.size).toBe(0);
  });

  it("fails closed when tab storage is unavailable", () => {
    const draft = requestDraft([makeNode("wallet-balance", PRIVATE_UID)], "warn");

    expect(
      storeBuilderLeadRequestDraft(
        { setItem: () => { throw new Error("storage denied"); } },
        draft,
      ),
    ).toBe(false);
    expect(
      consumeBuilderLeadRequestDraft({
        getItem: () => { throw new Error("storage denied"); },
        removeItem: () => {},
      }),
    ).toBeNull();
  });

  it("fails closed when the browser blocks access to sessionStorage itself", () => {
    const draft = requestDraft([makeNode("wallet-balance", PRIVATE_UID)], "warn");
    const blockedBrowser = {
      get sessionStorage(): Storage {
        throw new DOMException("storage denied", "SecurityError");
      },
    };

    expect(storeBuilderLeadRequestDraftInBrowser(draft, blockedBrowser)).toBe(false);
    expect(consumeBuilderLeadRequestDraftInBrowser(blockedBrowser)).toBeNull();
  });
});
