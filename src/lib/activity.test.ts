import { describe, expect, it } from "vitest";

import {
  ACTIVITY_FEED_LIMIT,
  aggregateActivity,
  assetSymbolFor,
  type CreatedLogInput,
  type ExecutedLogInput,
  type ExitLogInput,
} from "@/lib/activity";
import { ROBINHOOD_ASSETS } from "@/lib/robinhood";

const ZAP = "0x0006e5C42776239Db6abAeF3fdf22BbCfA8Cb5b4" as const;
const OWNER = "0x1111111111111111111111111111111111111111" as const;
const SPOOFER = "0x9999999999999999999999999999999999999999" as const;
const TX = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const NOW = "2026-07-22T00:00:00.000Z";

function created(overrides: Partial<CreatedLogInput> = {}): CreatedLogInput {
  return { zap: ZAP, owner: OWNER, txHash: TX(1), blockNumber: 100n, logIndex: 0, ...overrides };
}

function executed(overrides: Partial<ExecutedLogInput> = {}): ExecutedLogInput {
  return {
    emitter: ZAP,
    recipient: OWNER,
    outAsset: ROBINHOOD_ASSETS.zaps,
    amountOut: 5n * 10n ** 18n,
    txHash: TX(2),
    blockNumber: 200n,
    logIndex: 3,
    ...overrides,
  };
}

function exited(overrides: Partial<ExitLogInput> = {}): ExitLogInput {
  return {
    emitter: ZAP,
    owner: OWNER,
    asset: ROBINHOOD_ASSETS.weth,
    amount: 10n ** 15n,
    txHash: TX(3),
    blockNumber: 300n,
    logIndex: 1,
    ...overrides,
  };
}

describe("aggregateActivity integrity filter", () => {
  it("drops Executed and EmergencyExit logs from non-factory contracts", () => {
    const result = aggregateActivity(
      [created()],
      [executed(), executed({ emitter: SPOOFER, amountOut: 999_999n * 10n ** 18n, txHash: TX(9) })],
      [exited({ emitter: SPOOFER, txHash: TX(10) })],
      new Map(),
      NOW,
    );
    expect(result.stats.executions).toBe(1);
    expect(result.stats.recoveries).toBe(0);
    expect(result.stats.executedVolume["0xZAPS"]).toBe((5n * 10n ** 18n).toString());
    expect(result.activity.every((entry) => entry.zap === ZAP)).toBe(true);
  });

  it("matches emitters case-insensitively (log addresses arrive lowercase)", () => {
    const result = aggregateActivity(
      [created()],
      [executed({ emitter: ZAP.toLowerCase() as `0x${string}` })],
      [],
      new Map(),
      NOW,
    );
    expect(result.stats.executions).toBe(1);
  });
});

describe("aggregateActivity ordering and shape", () => {
  it("sorts newest block first, then highest log index", () => {
    const result = aggregateActivity(
      [created({ blockNumber: 100n })],
      [executed({ blockNumber: 300n, logIndex: 1, txHash: TX(4) }), executed({ blockNumber: 300n, logIndex: 7, txHash: TX(5) })],
      [exited({ blockNumber: 200n })],
      new Map([[100n, 1_700_000_000]]),
      NOW,
    );
    expect(result.activity.map((entry) => entry.txHash)).toEqual([TX(5), TX(4), TX(3), TX(1)]);
    expect(result.activity[3].timestamp).toBe(1_700_000_000);
    expect(result.activity[0].timestamp).toBeNull();
    expect(result.stats.lastActivityBlock).toBe("300");
  });

  it("caps the feed but counts full history in stats", () => {
    const many = Array.from({ length: ACTIVITY_FEED_LIMIT + 10 }, (_, i) =>
      created({ txHash: TX(100 + i), blockNumber: BigInt(1000 + i), logIndex: i }),
    );
    const result = aggregateActivity(many, [], [], new Map(), NOW);
    expect(result.activity).toHaveLength(ACTIVITY_FEED_LIMIT);
    expect(result.stats.zapsCreated).toBe(ACTIVITY_FEED_LIMIT + 10);
  });

  it("sums executed volume per asset symbol", () => {
    const result = aggregateActivity(
      [created()],
      [
        executed({ amountOut: 2n * 10n ** 18n, txHash: TX(6) }),
        executed({ amountOut: 3n * 10n ** 18n, txHash: TX(7), logIndex: 4 }),
        executed({ outAsset: ROBINHOOD_ASSETS.weth, amountOut: 10n ** 15n, txHash: TX(8), logIndex: 5 }),
      ],
      [],
      new Map(),
      NOW,
    );
    expect(result.stats.executedVolume["0xZAPS"]).toBe((5n * 10n ** 18n).toString());
    expect(result.stats.executedVolume["aeWETH"]).toBe((10n ** 15n).toString());
  });
});

describe("assetSymbolFor", () => {
  it("maps the pool assets and falls back to a short address", () => {
    expect(assetSymbolFor(ROBINHOOD_ASSETS.weth)).toBe("aeWETH");
    expect(assetSymbolFor(ROBINHOOD_ASSETS.zaps)).toBe("0xZAPS");
    expect(assetSymbolFor("0x9999999999999999999999999999999999999999")).toBe("0x9999…9999");
  });
});
