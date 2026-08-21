import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import {
  actionFromPending,
  assertCampaign2SettlementBindings,
  buildCampaign2CastMktxArgs,
  campaign2BurnRebroadcastFreshness,
  handleMissingPendingReceipt,
  loadCampaign2DaemonConfig,
  normalizeState,
  pendingBroadcastAllowed,
  recordPriceObservation,
  verifyCampaign2PriceObservationJournal,
  verifyCampaign2SignedTransaction,
} from "./campaign2-daemon.mjs";
import {
  CAMPAIGN2_ACTIONS,
  CAMPAIGN2_MANIFEST,
  campaign2BurnAction,
  deriveCampaign2MedianFloor,
} from "./campaign2-keeper.mjs";

const EMPTY_HOME = "/tmp/openzaps-campaign2-config-does-not-exist";
const LIVE_HOME = join(homedir(), ".openzaps", "campaign2-keeper");

test("campaign-2 daemon defaults to a disabled 24-hour, four-write policy", () => {
  const cfg = loadCampaign2DaemonConfig({ OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.cadenceSeconds, 86_400n);
  assert.equal(cfg.maxBroadcastsPerDay, 4);
  assert.equal(cfg.maxFeePerGasWei, 100_000_000n);
  assert.equal(cfg.gasWarnBalanceWei, 300_000_000_000_000n);
  assert.equal(cfg.autoFinalize, true);
  assert.equal(cfg.automateBurns, false);
  assert.equal(cfg.archiveRpcFile, null);
  assert.equal(cfg.keystoreFile, null);
  assert.equal(cfg.passwordFile, null);
  assert.equal(cfg.castBin, null);
});

test("campaign-2 daemon refuses raw keys and non-absolute encrypted signer paths", () => {
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
      OPENZAPS_CAMPAIGN2_KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    }),
    /raw campaign-2 private keys are refused/,
  );
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
      OPENZAPS_CAMPAIGN2_KEYSTORE_FILE: "relative.keystore",
      OPENZAPS_CAMPAIGN2_PASSWORD_FILE: "/secure/keeper.pass",
    }),
    /absolute path/,
  );
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
      OPENZAPS_CAMPAIGN2_KEYSTORE_FILE: "/secure/keeper.keystore",
    }),
    /must be configured together/,
  );
});

test("campaign-2 daemon rejects credential-bearing RPCs and widened budgets", () => {
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
      OPENZAPS_CAMPAIGN2_RPC_URL: "https://rpc.example/path?key=secret",
    }),
    /credential-free HTTPS origin/,
  );
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
      OPENZAPS_CAMPAIGN2_MAX_TX_PER_DAY: "9",
    }),
    /integer from 1 to 4/,
  );
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
      OPENZAPS_CAMPAIGN2_CADENCE_SECONDS: "3600",
    }),
    /integer from 86400 to 172800/,
  );
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
      OPENZAPS_CAMPAIGN2_CONFIRMATIONS: "1",
    }),
    /integer from 12 to 128/,
  );
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
      OPENZAPS_CAMPAIGN2_MAX_FEE_PER_GAS_WEI: "100000001",
    }),
    /must not exceed 100000000/,
  );
});

test("campaign-2 daemon accepts only explicit boolean activation", () => {
  const cfg = loadCampaign2DaemonConfig({
    OPENZAPS_CAMPAIGN2_HOME: LIVE_HOME,
    OPENZAPS_CAMPAIGN2_ENABLED: "true",
    OPENZAPS_CAMPAIGN2_KEYSTORE_FILE: "/secure/keeper.keystore",
    OPENZAPS_CAMPAIGN2_PASSWORD_FILE: "/secure/keeper.pass",
    OPENZAPS_CAMPAIGN2_CAST_BIN: "/secure/cast",
    OPENZAPS_CAMPAIGN2_APPROVED_COMMIT: "1".repeat(40),
    OPENZAPS_CAMPAIGN2_BUNDLE_SHA256: "2".repeat(64),
    OPENZAPS_CAMPAIGN2_CHUNK_SHA256: "3".repeat(64),
    OPENZAPS_CAMPAIGN2_NODE_SHA256: "4".repeat(64),
    OPENZAPS_CAMPAIGN2_CAST_SHA256: "5".repeat(64),
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.keystoreFile, "/secure/keeper.keystore");
  assert.equal(cfg.passwordFile, "/secure/keeper.pass");
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
      OPENZAPS_CAMPAIGN2_ENABLED: "yes",
    }),
    /must be true or false/,
  );
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: LIVE_HOME,
      OPENZAPS_CAMPAIGN2_ENABLED: "true",
    }),
    /complete encrypted signer configuration/,
  );
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: LIVE_HOME,
      OPENZAPS_CAMPAIGN2_ENABLED: "true",
      OPENZAPS_CAMPAIGN2_KEYSTORE_FILE: "/secure/keeper.keystore",
      OPENZAPS_CAMPAIGN2_PASSWORD_FILE: "/secure/keeper.pass",
      OPENZAPS_CAMPAIGN2_CAST_BIN: "/secure/cast",
    }),
    /immutable bundle, runtime, and Cast pins/,
  );
});

test("the installer verifies Cast before keystore access and never ignores a loaded job", () => {
  const installer = readFileSync(
    new URL("./install-campaign2-launchd.sh", import.meta.url),
    "utf8",
  );
  const launcher = readFileSync(new URL("./campaign2-launcher.sh", import.meta.url), "utf8");
  const castApproval = installer.indexOf("ACTUAL_CAST_SHA256");
  const walletAccess = installer.indexOf('wallet address --keystore');
  assert.ok(castApproval > 0 && castApproval < walletAccess);
  assert.match(installer, /OPENZAPS_CAMPAIGN2_EXPECTED_CAST_SHA256/);
  assert.match(installer, /OPENZAPS_CAMPAIGN2_EXPECTED_NODE_SHA256/);
  assert.match(installer, /OPENZAPS_CAMPAIGN2_EXPECTED_COMMIT/);
  assert.match(installer, /install_hashed_runtime/);
  assert.match(installer, /verify-campaign2-bundle\.mjs/);
  assert.match(installer, /PATH="\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/);
  assert.match(installer, /stop_loaded_job/);
  assert.match(installer, /launchctl print/);
  assert.doesNotMatch(installer, /launchctl bootout[^\n]+\|\| true/);
  assert.doesNotMatch(installer, /launchctl kickstart/);
  assert.match(installer, /PLIST_TMP=.*mktemp/);
  assert.match(launcher, /pre-execution runtime hash mismatch/);
  assert.ok(launcher.indexOf("file_sha256") < launcher.indexOf('exec "$NODE_BIN"'));
});

test("campaign-2 burn activation requires a separate owner-only archive RPC file", () => {
  assert.throws(
    () => loadCampaign2DaemonConfig({
      OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
      OPENZAPS_CAMPAIGN2_AUTOMATE_BURNS: "true",
    }),
    /archive RPC file/,
  );
  const cfg = loadCampaign2DaemonConfig({
    OPENZAPS_CAMPAIGN2_HOME: EMPTY_HOME,
    OPENZAPS_CAMPAIGN2_AUTOMATE_BURNS: "true",
    OPENZAPS_CAMPAIGN2_ARCHIVE_RPC_FILE: "/secure/robinhood-archive-rpc.url",
  });
  assert.equal(cfg.automateBurns, true);
  assert.equal(cfg.archiveRpcFile, "/secure/robinhood-archive-rpc.url");
});

test("campaign-2 Cast arguments use a password file and one pinned action", () => {
  const action = campaign2BurnAction(123n);
  const args = buildCampaign2CastMktxArgs({
    action,
    cfg: {
      maxFeePerGasWei: 100_000_000n,
      keystoreFile: "/secure/keeper.keystore",
      passwordFile: "/secure/keeper.pass",
    },
    nonce: 2,
    priorityFee: 5_000_000n,
  });
  assert.deepEqual(args.slice(-3), [action.target, "buyAndBurn(uint256)", "123"]);
  assert.equal(args.includes("--password-file"), true);
  assert.equal(args.includes("--password"), false);
  assert.equal(args.includes("--private-key"), false);
});

test("campaign-2 pool journal records at most one canonical sample per five-minute bucket", () => {
  const state = { priceObservations: [] };
  const base = {
    blockNumber: 100n,
    blockHash: `0x${"12".repeat(32)}`,
    blockTimestamp: 1_000n,
    sqrtPriceX96: 1n << 96n,
  };
  assert.equal(recordPriceObservation(state, base), true);
  assert.equal(recordPriceObservation(state, {
    ...base,
    blockNumber: 101n,
    blockHash: `0x${"13".repeat(32)}`,
    blockTimestamp: 1_199n,
    sqrtPriceX96: (1n << 96n) + 1n,
  }), false);
  assert.equal(state.priceObservations.length, 1);
  assert.equal(recordPriceObservation(state, {
    ...base,
    blockNumber: 102n,
    blockHash: `0x${"14".repeat(32)}`,
    blockTimestamp: 1_200n,
    sqrtPriceX96: (1n << 96n) + 2n,
  }), true);
  assert.equal(state.priceObservations.length, 2);
});

test("campaign-2 price evidence requires archived slot0 to match every canonical sample", async () => {
  const blockHash = `0x${"12".repeat(32)}`;
  const sqrtPriceX96 = 1n << 96n;
  const state = {
    priceObservations: [{
      bucket: "3",
      blockNumber: "100",
      blockHash,
      blockTimestamp: "1000",
      sqrtPriceX96: sqrtPriceX96.toString(),
      priceX96: sqrtPriceX96.toString(),
    }],
  };
  const publicClient = {
    getBlock: async () => ({ hash: blockHash, timestamp: 1_000n }),
  };
  const archiveClient = {
    getBlock: async () => ({ hash: blockHash, timestamp: 1_000n }),
    readContract: async () => `0x${sqrtPriceX96.toString(16).padStart(64, "0")}`,
  };
  assert.deepEqual(
    await verifyCampaign2PriceObservationJournal(publicClient, archiveClient, state, 1_000n),
    { valid: true, changed: false },
  );
  const substitutedArchive = {
    ...archiveClient,
    readContract: async () => `0x${(sqrtPriceX96 + 1n).toString(16).padStart(64, "0")}`,
  };
  assert.match(
    (await verifyCampaign2PriceObservationJournal(
      publicClient,
      substitutedArchive,
      state,
      1_000n,
    )).reason,
    /archived slot0 does not match/,
  );
});

test("campaign-2 state rejects duplicate observations and malformed daily counters", () => {
  const first = {
    bucket: "3",
    blockNumber: "100",
    blockHash: `0x${"12".repeat(32)}`,
    blockTimestamp: "1000",
    sqrtPriceX96: (1n << 96n).toString(),
    priceX96: (1n << 96n).toString(),
  };
  assert.throws(
    () => normalizeState({ priceObservations: [first, { ...first }] }),
    /unique and monotonic/,
  );
  assert.throws(
    () => normalizeState({ daily: { day: "1", broadcasts: -1 } }),
    /daily broadcast state is malformed/,
  );
});

test("campaign-2 pending burn evidence reproduces one full-batch floor exactly", () => {
  const nowSec = CAMPAIGN2_MANIFEST.startAt + 3_600n;
  const sqrtPriceX96 = 110_997_308_086_128_931_532_710_260_984_345n;
  const samples = Array.from({ length: 7 }, (_, index) => {
    const blockTimestamp = nowSec - 2_100n + BigInt(index * 300);
    return {
      bucket: blockTimestamp / 300n,
      blockNumber: BigInt(100 + index),
      blockHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      blockTimestamp,
      sqrtPriceX96,
    };
  });
  const derived = deriveCampaign2MedianFloor({
    observations: samples,
    nowSec,
    ethIn: CAMPAIGN2_MANIFEST.maxBuyWei,
  });
  assert.equal(derived.ready, true);
  const pending = {
    actionId: "hookr-buy-and-burn",
    actionArgs: [derived.minHookrOut.toString()],
    signedAtBlockNumber: "201",
    signedAtBlockHash: `0x${"cd".repeat(32)}`,
    signedAtBlockTimestamp: (nowSec + 1n).toString(),
    floorEvidence: {
      source: "hookr-v4-full-batch-archive-median-v3",
      decisionBlockNumber: "200",
      decisionBlockHash: `0x${"ab".repeat(32)}`,
      decisionBlockTimestamp: nowSec.toString(),
      effectiveEthInWei: CAMPAIGN2_MANIFEST.maxBuyWei.toString(),
      minHookrOut: derived.minHookrOut.toString(),
      medianPriceX96: derived.medianPriceX96.toString(),
      minOutBps: CAMPAIGN2_MANIFEST.minOutBps.toString(),
      sampleCount: derived.sampleCount,
      sampleSpanSeconds: derived.sampleSpanSeconds.toString(),
      firstBlockNumber: derived.firstBlockNumber.toString(),
      lastBlockNumber: derived.lastBlockNumber.toString(),
      samples: samples.map((sample) => ({
        bucket: sample.bucket.toString(),
        blockNumber: sample.blockNumber.toString(),
        blockHash: sample.blockHash,
        blockTimestamp: sample.blockTimestamp.toString(),
        sqrtPriceX96: sample.sqrtPriceX96.toString(),
      })),
    },
  };
  assert.deepEqual(actionFromPending(pending).args, [derived.minHookrOut]);
  assert.throws(
    () => actionFromPending({
      ...pending,
      floorEvidence: { ...pending.floorEvidence, sampleCount: derived.sampleCount + 1 },
    }),
    /sample bounds are malformed/,
  );
  assert.throws(
    () => actionFromPending({
      ...pending,
      floorEvidence: {
        ...pending.floorEvidence,
        effectiveEthInWei: CAMPAIGN2_MANIFEST.minBuyWei.toString(),
      },
    }),
    /input evidence is outside immutable bounds/,
  );
});

test("status and watch-only hold a signed pending transaction without rebroadcast", async () => {
  let rebroadcasts = 0;
  const pending = {
    actionId: "staker-harvest",
    txHash: `0x${"12".repeat(32)}`,
  };
  const held = await handleMissingPendingReceipt({
    pending,
    allowBroadcast: false,
    rebroadcast: async () => { rebroadcasts += 1; },
  });
  assert.deepEqual(held, { handled: true, pending: true });
  assert.equal(rebroadcasts, 0);
  await handleMissingPendingReceipt({
    pending,
    allowBroadcast: true,
    rebroadcast: async () => { rebroadcasts += 1; },
  });
  assert.equal(rebroadcasts, 1);
});

test("the burn-off switch holds a pending signed burn while other enabled actions may retry", () => {
  const base = {
    command: "start",
    cfg: { enabled: true, automateBurns: false },
    signer: { address: CAMPAIGN2_MANIFEST.keeper },
  };
  assert.equal(pendingBroadcastAllowed({
    ...base,
    pending: { actionId: "hookr-buy-and-burn" },
  }), false);
  assert.equal(pendingBroadcastAllowed({
    ...base,
    pending: { actionId: "staker-harvest" },
  }), true);
  assert.equal(pendingBroadcastAllowed({
    ...base,
    command: "status",
    pending: { actionId: "staker-harvest" },
  }), false);
});

test("campaign-2 burn rebroadcasts expire on canonical chain time", () => {
  const pending = {
    actionId: "hookr-buy-and-burn",
    signedAtBlockNumber: "200",
    signedAtBlockHash: `0x${"ab".repeat(32)}`,
    signedAtBlockTimestamp: "1000",
  };
  const signedBlock = {
    number: 200n,
    hash: pending.signedAtBlockHash,
    timestamp: 1_000n,
  };
  assert.deepEqual(
    campaign2BurnRebroadcastFreshness(pending, signedBlock, {
      number: 210n,
      hash: `0x${"bc".repeat(32)}`,
      timestamp: 1_600n,
    }, undefined, 1_600n),
    { allowed: true, ageSeconds: 600n },
  );
  assert.match(
    campaign2BurnRebroadcastFreshness(pending, signedBlock, {
      number: 211n,
      hash: `0x${"bd".repeat(32)}`,
      timestamp: 1_601n,
    }, undefined, 1_601n).reason,
    /manual nonce replacement/,
  );
  assert.match(
    campaign2BurnRebroadcastFreshness(pending, signedBlock, {
      number: 210n,
      hash: `0x${"bc".repeat(32)}`,
      timestamp: 1_600n,
    }, undefined, 1_721n).reason,
    /wall-clock bound/,
  );
});

test("campaign-2 settlement binds receipt, transaction, block, and readback hashes", () => {
  const txHash = `0x${"12".repeat(32)}`;
  const blockHash = `0x${"34".repeat(32)}`;
  const settlement = {
    pending: { txHash },
    receipt: { transactionHash: txHash, blockHash, blockNumber: 123n },
    transaction: { hash: txHash, blockHash, blockNumber: 123n },
    block: { hash: blockHash, number: 123n },
    after: { blockHash, blockNumber: 123n },
  };
  assert.doesNotThrow(() => assertCampaign2SettlementBindings(settlement));
  assert.throws(
    () => assertCampaign2SettlementBindings({
      ...settlement,
      after: { ...settlement.after, blockHash: `0x${"56".repeat(32)}` },
    }),
    /not one settlement/,
  );
});

test("campaign-2 signed payload is recovered and checked before publication", async () => {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const action = CAMPAIGN2_ACTIONS["staker-harvest"];
  const maxFeePerGasWei = 100_000_000n;
  const priorityFeeWei = 5_000_000n;
  const nonce = 2;
  const serializedTransaction = await account.signTransaction({
    type: "eip1559",
    chainId: CAMPAIGN2_MANIFEST.chainId,
    nonce,
    gas: action.gas,
    maxFeePerGas: maxFeePerGasWei,
    maxPriorityFeePerGas: priorityFeeWei,
    to: action.target,
    value: 0n,
    data: encodeFunctionData({
      abi: action.abi,
      functionName: action.functionName,
      args: action.args,
    }),
  });
  const verified = await verifyCampaign2SignedTransaction({
    serializedTransaction,
    action,
    expectedSigner: account.address,
    nonce,
    maxFeePerGasWei,
    priorityFeeWei,
  });
  assert.equal(verified.signer, account.address);
  assert.match(verified.txHash, /^0x[0-9a-f]{64}$/);
  await assert.rejects(
    verifyCampaign2SignedTransaction({
      serializedTransaction,
      action,
      expectedSigner: CAMPAIGN2_MANIFEST.keeper,
      nonce,
      maxFeePerGasWei,
      priorityFeeWei,
    }),
    /unexpected signer/,
  );
  const legacyTransaction = await account.signTransaction({
    type: "legacy",
    chainId: CAMPAIGN2_MANIFEST.chainId,
    nonce,
    gas: action.gas,
    gasPrice: maxFeePerGasWei,
    to: action.target,
    value: 0n,
    data: encodeFunctionData({
      abi: action.abi,
      functionName: action.functionName,
      args: action.args,
    }),
  });
  await assert.rejects(
    verifyCampaign2SignedTransaction({
      serializedTransaction: legacyTransaction,
      action,
      expectedSigner: account.address,
      nonce,
      maxFeePerGasWei,
      priorityFeeWei,
    }),
    /plain EIP-1559/,
  );
});
