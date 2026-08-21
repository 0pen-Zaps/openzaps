import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData } from "viem";

import {
  CAMPAIGN2_MANIFEST,
  campaign2BurnAction,
  campaign2EffectiveBuyInput,
  campaign2FloorFromSqrtPrice,
  campaign2HarvestWindow,
  deriveCampaign2MedianFloor,
  planCampaign2Maintenance,
  verifyCampaign2Receipt,
  verifyCampaign2Transaction,
} from "./campaign2-keeper.mjs";

test("executor release pins stay identical to the app's released campaign-2 manifest", () => {
  const appManifest = readFileSync(new URL("../src/lib/rewards2.ts", import.meta.url), "utf8");
  const normalized = appManifest.replaceAll("_", "").toLowerCase();
  for (const expected of [
    CAMPAIGN2_MANIFEST.campaign.address,
    CAMPAIGN2_MANIFEST.campaign.runtimeCodeHash,
    CAMPAIGN2_MANIFEST.hookBlocks.address,
    CAMPAIGN2_MANIFEST.hookBlocks.runtimeCodeHash,
    CAMPAIGN2_MANIFEST.poolManager.address,
    CAMPAIGN2_MANIFEST.poolId,
    CAMPAIGN2_MANIFEST.startAt.toString(),
    CAMPAIGN2_MANIFEST.endAt.toString(),
    CAMPAIGN2_MANIFEST.claimDeadline.toString(),
    CAMPAIGN2_MANIFEST.minBuyWei.toString(),
    CAMPAIGN2_MANIFEST.maxBuyWei.toString(),
    CAMPAIGN2_MANIFEST.minOutBps.toString(),
  ]) {
    assert.ok(normalized.includes(String(expected).toLowerCase()), `missing released pin ${expected}`);
  }
});

function snapshot(overrides = {}) {
  return {
    blockTimestamp: CAMPAIGN2_MANIFEST.startAt,
    campaign: { funded: true, finalized: false },
    hookBlocks: {
      funded: true,
      finalized: false,
      buybackPaused: false,
      pendingWeth: 0n,
      minBuyWei: CAMPAIGN2_MANIFEST.minBuyWei,
    },
    ...overrides,
    campaign: { funded: true, finalized: false, ...(overrides.campaign ?? {}) },
    hookBlocks: {
      funded: true,
      finalized: false,
      buybackPaused: false,
      pendingWeth: 0n,
      minBuyWei: CAMPAIGN2_MANIFEST.minBuyWei,
      ...(overrides.hookBlocks ?? {}),
    },
  };
}

test("launch-day window is not harvested twice", () => {
  const plan = planCampaign2Maintenance({ snapshot: snapshot(), lastHarvestWindow: -1n });
  assert.equal(plan.outcome, "idle");
  assert.equal(plan.action, null);
});

test("one cadence after launch plans the staker harvest before the burn", () => {
  const current = snapshot({
    blockTimestamp: CAMPAIGN2_MANIFEST.startAt + 86_400n,
    hookBlocks: { pendingWeth: CAMPAIGN2_MANIFEST.minBuyWei },
  });
  const plan = planCampaign2Maintenance({ snapshot: current, lastHarvestWindow: 0n });
  assert.equal(plan.action.id, "staker-harvest");
  assert.equal(plan.harvestWindow, 1n);
});

test("a current harvest window plans a burn only for a full immutable buy-cap batch", () => {
  const before = planCampaign2Maintenance({
    snapshot: snapshot({
      blockTimestamp: CAMPAIGN2_MANIFEST.startAt + 86_400n,
      hookBlocks: { pendingWeth: CAMPAIGN2_MANIFEST.maxBuyWei - 1n },
    }),
    lastHarvestWindow: 1n,
  });
  assert.equal(before.action, null);

  const at = planCampaign2Maintenance({
    snapshot: snapshot({
      blockTimestamp: CAMPAIGN2_MANIFEST.startAt + 86_400n,
      hookBlocks: { pendingWeth: CAMPAIGN2_MANIFEST.maxBuyWei },
    }),
    lastHarvestWindow: 1n,
  });
  assert.equal(at.action.id, "hookr-buy-and-burn");
});

test("automated burns require a fresh 30-minute median and a positive caller floor", () => {
  const nowSec = CAMPAIGN2_MANIFEST.startAt + 3_600n;
  const sqrtPriceX96 = 110_997_308_086_128_931_532_710_260_984_345n;
  const observations = Array.from({ length: 7 }, (_, index) => ({
    bucket: (nowSec - 2_100n + BigInt(index * 300)) / 300n,
    blockNumber: BigInt(100 + index),
    blockHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    blockTimestamp: nowSec - 2_100n + BigInt(index * 300),
    sqrtPriceX96,
  }));
  const derived = deriveCampaign2MedianFloor({
    observations,
    nowSec,
    ethIn: CAMPAIGN2_MANIFEST.maxBuyWei,
  });
  assert.equal(derived.ready, true);
  assert.equal(
    derived.minHookrOut,
    campaign2FloorFromSqrtPrice({
      sqrtPriceX96,
      ethIn: CAMPAIGN2_MANIFEST.maxBuyWei,
    }),
  );
  assert.ok(derived.minHookrOut > 0n);
  assert.equal(derived.minHookrOut, 95_193_537_034_172_524_882_416n);
  assert.deepEqual(campaign2BurnAction(derived.minHookrOut).args, [derived.minHookrOut]);

  const insufficient = deriveCampaign2MedianFloor({
    observations: observations.slice(0, 6),
    nowSec,
    ethIn: CAMPAIGN2_MANIFEST.maxBuyWei,
  });
  assert.equal(insufficient.ready, false);
  assert.match(insufficient.reason, /need 7/);
  const gapped = observations.map((entry, index) => {
    if (index < 3) return entry;
    const blockTimestamp = entry.blockTimestamp + 1_000n;
    return { ...entry, blockTimestamp, bucket: blockTimestamp / 300n };
  });
  const excessiveGap = deriveCampaign2MedianFloor({
    observations: gapped,
    nowSec: nowSec + 1_000n,
    ethIn: CAMPAIGN2_MANIFEST.maxBuyWei,
  });
  assert.equal(excessiveGap.ready, false);
  assert.match(excessiveGap.reason, /excessive gap/);

  const outliers = observations.map((entry, index) => (
    index < 3 ? { ...entry, sqrtPriceX96: sqrtPriceX96 * 100n } : entry
  ));
  const robust = deriveCampaign2MedianFloor({
    observations: outliers,
    nowSec,
    ethIn: CAMPAIGN2_MANIFEST.maxBuyWei,
  });
  assert.equal(robust.ready, true);
  assert.equal(robust.minHookrOut, derived.minHookrOut);
  const duplicated = observations.map((entry, index) => (index >= 3 ? observations[3] : entry));
  const duplicateResult = deriveCampaign2MedianFloor({
    observations: duplicated,
    nowSec,
    ethIn: CAMPAIGN2_MANIFEST.maxBuyWei,
  });
  assert.equal(duplicateResult.ready, false);
  assert.match(duplicateResult.reason, /unique and strictly monotonic/);
  const wrongBucket = observations.map((entry, index) => (
    index === 3 ? { ...entry, bucket: entry.bucket + 1n } : entry
  ));
  const wrongBucketResult = deriveCampaign2MedianFloor({
    observations: wrongBucket,
    nowSec,
    ethIn: CAMPAIGN2_MANIFEST.maxBuyWei,
  });
  assert.equal(wrongBucketResult.ready, false);
  assert.match(wrongBucketResult.reason, /structurally invalid/);
  assert.throws(() => campaign2BurnAction(0n), /positive bigint/);
  assert.equal(
    campaign2EffectiveBuyInput(CAMPAIGN2_MANIFEST.maxBuyWei + 1n),
    CAMPAIGN2_MANIFEST.maxBuyWei,
  );
  assert.throws(
    () => campaign2EffectiveBuyInput(CAMPAIGN2_MANIFEST.maxBuyWei - 1n),
    /below the full immutable buy cap/,
  );
});

test("the sponsor pause blocks only the burn plan", () => {
  const dueHarvest = planCampaign2Maintenance({
    snapshot: snapshot({
      blockTimestamp: CAMPAIGN2_MANIFEST.startAt + 86_400n,
      hookBlocks: { buybackPaused: true, pendingWeth: CAMPAIGN2_MANIFEST.maxBuyWei },
    }),
    lastHarvestWindow: 0n,
  });
  assert.equal(dueHarvest.action.id, "staker-harvest");

  const currentHarvest = planCampaign2Maintenance({
    snapshot: snapshot({
      blockTimestamp: CAMPAIGN2_MANIFEST.startAt + 86_400n,
      hookBlocks: { buybackPaused: true, pendingWeth: CAMPAIGN2_MANIFEST.maxBuyWei },
    }),
    lastHarvestWindow: 1n,
  });
  assert.equal(currentHarvest.action, null);
  assert.match(currentHarvest.reason, /sponsor-paused/);
});

test("post-window lifecycle finalizes both legs in order and never plans a sweep", () => {
  const ended = CAMPAIGN2_MANIFEST.endAt + 1n;
  const campaign = planCampaign2Maintenance({ snapshot: snapshot({ blockTimestamp: ended }) });
  assert.equal(campaign.action.id, "campaign-finalize");

  const hookBlocks = planCampaign2Maintenance({
    snapshot: snapshot({ blockTimestamp: ended, campaign: { finalized: true } }),
  });
  assert.equal(hookBlocks.action.id, "hook-blocks-finalize");

  const residual = planCampaign2Maintenance({
    snapshot: snapshot({
      blockTimestamp: ended,
      campaign: { finalized: true },
      hookBlocks: { finalized: true, pendingWeth: CAMPAIGN2_MANIFEST.maxBuyWei },
    }),
  });
  assert.equal(residual.action.id, "hookr-buy-and-burn");

  const dry = planCampaign2Maintenance({
    snapshot: snapshot({
      blockTimestamp: ended,
      campaign: { finalized: true },
      hookBlocks: { finalized: true, pendingWeth: 0n },
    }),
  });
  assert.equal(dry.action, null);
  assert.match(dry.reason, /no sweep is automated/);
});

test("invalid cadence and incomplete funding fail closed", () => {
  assert.equal(
    planCampaign2Maintenance({ snapshot: snapshot(), cadenceSeconds: 60n }).outcome,
    "blocked",
  );
  assert.equal(
    planCampaign2Maintenance({ snapshot: snapshot({ campaign: { funded: false } }) }).outcome,
    "blocked",
  );
});

test("harvest windows are anchored to the immutable campaign start", () => {
  assert.equal(campaign2HarvestWindow(CAMPAIGN2_MANIFEST.startAt - 1n, 86_400n), -1n);
  assert.equal(campaign2HarvestWindow(CAMPAIGN2_MANIFEST.startAt, 86_400n), 0n);
  assert.equal(campaign2HarvestWindow(CAMPAIGN2_MANIFEST.startAt + 172_801n, 86_400n), 2n);
});

test("settled transactions must preserve target, selector, zero value, and burn arg", () => {
  const action = campaign2BurnAction(123n);
  const input = encodeFunctionData({
    abi: action.abi,
    functionName: action.functionName,
    args: action.args,
  });
  assert.equal(
    verifyCampaign2Transaction(action, { to: action.target, input, value: 0n }).functionName,
    "buyAndBurn",
  );
  assert.throws(
    () => verifyCampaign2Transaction(action, { to: CAMPAIGN2_MANIFEST.campaign.address, input, value: 0n }),
    /target/,
  );
  assert.throws(
    () => verifyCampaign2Transaction(action, { to: action.target, input, value: 1n }),
    /native value/,
  );
  const widened = encodeFunctionData({ abi: action.abi, functionName: action.functionName, args: [124n] });
  assert.throws(
    () => verifyCampaign2Transaction(action, { to: action.target, input: widened, value: 0n }),
    /argument 0/,
  );
});

test("a successful burn receipt requires the HookBlocks event at the canonical block", () => {
  const action = campaign2BurnAction(123n);
  const input = encodeFunctionData({ abi: action.abi, functionName: action.functionName, args: action.args });
  const blockHash = `0x${"12".repeat(32)}`;
  const tx = { to: action.target, input, value: 0n };
  const baseReceipt = { status: "success", blockHash, logs: [] };
  assert.throws(
    () => verifyCampaign2Receipt(action, baseReceipt, tx, { hash: blockHash }),
    /postcondition event/,
  );
  const verified = verifyCampaign2Receipt(
    action,
    {
      ...baseReceipt,
      logs: [{
        address: action.target,
        topics: encodeEventTopics({
          abi: action.abi,
          eventName: "BoughtAndBurned",
          args: {
            caller: "0x0000000000000000000000000000000000000001",
            blockIndex: 1n,
          },
        }),
        data: encodeAbiParameters(
          [
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
          ],
          [CAMPAIGN2_MANIFEST.maxBuyWei, 1_000n, 1_000n, 123n],
        ),
      }],
    },
    tx,
    { hash: blockHash },
  );
  assert.deepEqual(verified, {
    outcome: "finalized",
    eventObserved: true,
    eventDetails: {
      ethIn: CAMPAIGN2_MANIFEST.maxBuyWei.toString(),
      hookrBought: "1000",
      hookrBurned: "1000",
      floor: "123",
    },
  });
});
