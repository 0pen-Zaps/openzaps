import assert from "node:assert/strict";
import { test } from "node:test";

import { checkNonceLane, createAsyncMutex, submitExecution } from "./engine.mjs";
import { convertPotFees } from "./keeper.mjs";
import { createReceiptOutboxController } from "./receipt-source.mjs";

const Q96 = 1n << 96n;
const ONE = 1_000_000_000_000_000_000n;
const WALLET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

test("intent and maintenance writes share one admission-to-outbox signer lane", async () => {
  const events = [];
  let pending = false;
  let broadcasts = 0;
  let beginOutbox;
  let finishOutbox;
  let maintenanceQueued;
  const outboxStarted = new Promise((resolve) => {
    beginOutbox = resolve;
  });
  const releaseOutbox = new Promise((resolve) => {
    finishOutbox = resolve;
  });
  const maintenanceLaneRequested = new Promise((resolve) => {
    maintenanceQueued = resolve;
  });

  const mutex = createAsyncMutex();
  const intentLane = (operation) => {
    events.push("intent-lane-request");
    return mutex(operation);
  };
  const maintenanceLane = (operation) => {
    events.push("maintenance-lane-request");
    maintenanceQueued();
    return mutex(operation);
  };
  const walletClient = {
    account: { address: WALLET },
    writeContract: async (request) => {
      broadcasts += 1;
      pending = true;
      events.push(`${request.functionName}-write`);
      return `0x${"12".repeat(32)}`;
    },
  };

  const intentPromise = submitExecution(
    {
      simulateContract: async () => ({
        request: {
          address: "0x9941dD72373429C36F82D888dbcbab080038f033",
          functionName: "executeRecurring",
        },
      }),
      getBlock: async () => ({ baseFeePerGas: 1n }),
      waitForTransactionReceipt: async () => {
        events.push("intent-receipt-wait");
        return { status: "success", blockNumber: 123n };
      },
    },
    walletClient,
    {
      kind: "recurring",
      signature: `0x${"ab".repeat(65)}`,
      intent: {
        zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
        executor: "0x0000000000000000000000000000000000000000",
        maxGas: 3_000_000n,
        maxFeePerGas: 2_000_000_000n,
      },
    },
    {
      maxFeePerGasWei: 2_000_000_000n,
      confirmations: 1,
      receiptTimeoutMs: 45_000,
    },
    async () => {
      events.push("intent-outbox-start");
      beginOutbox();
      await releaseOutbox;
      events.push("intent-outbox-end");
    },
    async () => ({ verified: true }),
    async () => {
      events.push("intent-admission");
      return { allowed: true };
    },
    intentLane,
  );

  await outboxStarted;
  const maintenancePromise = convertPotFees({
    publicClient: {
      readContract: async ({ functionName }) => (functionName === "balanceOf" ? ONE : 2n * Q96),
      simulateContract: async () => ({
        request: {
          address: "0x0000000000000000000000000000000000000001",
          functionName: "buyZaps",
        },
      }),
      getBlock: async () => ({ baseFeePerGas: 1n }),
    },
    walletClient,
    cfg: {
      lotteryPot: "0x0000000000000000000000000000000000000001",
      poolPriceSource: "0x0000000000000000000000000000000000000002",
      feeAsset: "0x0000000000000000000000000000000000000003",
      convertMinWei: 1n,
      convertSlippageBps: 300,
      maxFeePerGasWei: 2_000_000_000n,
    },
    canBroadcast: async () => {
      events.push("maintenance-admission");
      return pending
        ? {
            allowed: false,
            outcome: "nonce-lane-pending",
            detail: "the intent broadcast now occupies the wallet nonce lane",
          }
        : { allowed: true };
    },
    withBroadcastLane: maintenanceLane,
  });

  await maintenanceLaneRequested;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes("maintenance-admission"), false);

  finishOutbox();
  const [intent, maintenance] = await Promise.all([intentPromise, maintenancePromise]);

  assert.equal(intent.outcome, "confirmation-observed");
  assert.equal(maintenance.outcome, "nonce-lane-pending");
  assert.equal(broadcasts, 1);
  assert.ok(events.indexOf("intent-outbox-end") < events.indexOf("maintenance-admission"));
});

test("a durable execution marker blocks a restart even when pending RPC is stale-clear", async () => {
  let durableState = {};
  let broadcasts = 0;
  const staleClearRpc = {
    simulateContract: async () => ({
      request: {
        address: "0x9941dD72373429C36F82D888dbcbab080038f033",
        functionName: "executeRecurring",
      },
    }),
    getBlock: async () => ({ baseFeePerGas: 1n }),
    getTransactionCount: async () => 9,
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 123n }),
  };
  const walletClient = {
    account: { address: WALLET },
    writeContract: async () => {
      broadcasts += 1;
      return `0x${"34".repeat(32)}`;
    },
  };
  const item = {
    kind: "recurring",
    signature: `0x${"ab".repeat(65)}`,
    intent: {
      zap: "0x9941dD72373429C36F82D888dbcbab080038f033",
      executor: "0x0000000000000000000000000000000000000000",
      seriesId: 1n,
      maxGas: 3_000_000n,
      maxFeePerGas: 2_000_000_000n,
    },
  };
  const firstState = {};
  const firstController = createReceiptOutboxController(firstState, async (state) => {
    durableState = JSON.parse(JSON.stringify(state));
  });
  const first = await submitExecution(
    staleClearRpc,
    walletClient,
    item,
    {
      maxFeePerGasWei: 2_000_000_000n,
      confirmations: 1,
      receiptTimeoutMs: 45_000,
    },
    ({ hash }) => firstController.record(item, hash),
    async () => ({ verified: true }),
    async () => {
      const durableAdmission = firstController.admission();
      return durableAdmission.allowed
        ? checkNonceLane(staleClearRpc, walletClient)
        : durableAdmission;
    },
  );
  assert.equal(first.outcome, "confirmation-observed");
  assert.equal(broadcasts, 1);

  const restartedController = createReceiptOutboxController(durableState, async () => {});
  const staleRpcAdmission = await checkNonceLane(staleClearRpc, walletClient);
  assert.equal(staleRpcAdmission.allowed, true, "the fallback RPC has not propagated the pending nonce");

  const second = await submitExecution(
    staleClearRpc,
    walletClient,
    { ...item, intent: { ...item.intent, seriesId: 2n } },
    {
      maxFeePerGasWei: 2_000_000_000n,
      confirmations: 1,
      receiptTimeoutMs: 45_000,
    },
    async () => {},
    async () => ({ verified: true }),
    async () => {
      const durableAdmission = restartedController.admission();
      return durableAdmission.allowed
        ? checkNonceLane(staleClearRpc, walletClient)
        : durableAdmission;
    },
  );
  assert.equal(second.outcome, "nonce-lane-pending");
  assert.match(second.detail, /durable receipt state/);
  assert.equal(broadcasts, 1);
});

test("a keeper broadcast durably occupies the same signer lane before confirmation waiting", async () => {
  let durableState = {};
  const state = {};
  const events = [];
  const controller = createReceiptOutboxController(state, async (nextState) => {
    events.push("persist");
    durableState = JSON.parse(JSON.stringify(nextState));
  });
  const hash = `0x${"56".repeat(32)}`;
  const result = await convertPotFees({
    publicClient: {
      readContract: async ({ functionName }) => (functionName === "balanceOf" ? ONE : 2n * Q96),
      simulateContract: async () => ({
        request: {
          address: "0x0000000000000000000000000000000000000001",
          functionName: "buyZaps",
        },
      }),
      getBlock: async () => ({ baseFeePerGas: 1n }),
      waitForTransactionReceipt: async () => {
        events.push("wait");
        return { status: "success", blockNumber: 124n };
      },
    },
    walletClient: {
      account: { address: WALLET },
      writeContract: async () => {
        events.push("broadcast");
        return hash;
      },
    },
    cfg: {
      lotteryPot: "0x0000000000000000000000000000000000000001",
      poolPriceSource: "0x0000000000000000000000000000000000000002",
      feeAsset: "0x0000000000000000000000000000000000000003",
      convertMinWei: 1n,
      convertSlippageBps: 300,
      maxFeePerGasWei: 2_000_000_000n,
    },
    onBroadcast: ({ hash: transactionHash }) =>
      controller.recordOperation(
        {
          relayIntentId: null,
          zap: "0x0000000000000000000000000000000000000001",
          kind: "pot-conversion",
          nonce: transactionHash,
        },
        transactionHash,
      ),
  });

  assert.equal(result.outcome, "confirmation-observed");
  assert.deepEqual(events, ["broadcast", "persist", "wait"]);
  assert.ok(durableState.receiptOutbox[hash]);
  const restartedController = createReceiptOutboxController(durableState, async () => {});
  assert.equal(restartedController.admission().allowed, false);
  assert.equal(restartedController.admission().outcome, "nonce-lane-pending");
});
