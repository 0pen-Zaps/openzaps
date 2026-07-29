import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
} from "viem";
import {
  computeLaunchConfigHash,
  extractCanaryLaunches,
  LAUNCH_ABI,
  LAUNCH_PROVENANCE_ABI,
  parseForgeBroadcast,
  TOKEN_LAUNCHED_ABI,
  validateCanaryTransactionSequence,
} from "./forge-broadcast-evidence.mjs";

const SENDER = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const TREASURY = "0x3333333333333333333333333333333333333333";
const ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ERC20_WRITE_ABI = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const ERC20_TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const ROUTER_WRITE_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const VAULT_WRITE_ABI = parseAbi([
  "function harvest() returns (uint256 harvestedLaunchToken,uint256 harvestedPairedAsset)",
  "function transfer(address to,uint256 value) returns (bool)",
  "function claimAll(address recipient) returns (uint256 launchTokenAmount,uint256 pairedAssetAmount)",
]);

function launchReceipt({
  index,
  pair,
  floorTick,
  name,
  symbol,
  metadataURI,
  firstBuyAmount,
  minFirstBuyTokensOut = 1n,
}) {
  const token = `0x${String(index + 10).padStart(40, "0")}`;
  const vault = `0x${String(index + 20).padStart(40, "0")}`;
  const pool = `0x${String(index + 30).padStart(40, "0")}`;
  const transactionHash = `0x${String(index + 1).padStart(64, "0")}`;
  const blockNumber = 100n + BigInt(index);
  const nativeValue = pair === WETH ? (firstBuyAmount ?? 100n) : 0n;
  const params = {
    name,
    symbol,
    metadataURI,
    salt: `0x${String(index + 500).padStart(64, "0")}`,
    floorTick,
    pairedAsset: pair,
    feeTier: 3000,
    firstBuyPairIn: pair === WETH ? 0n : (firstBuyAmount ?? 1_000_000n),
    minFirstBuyTokensOut,
  };
  const configHash = computeLaunchConfigHash({
    launchpad: TARGET,
    creator: SENDER,
    params,
    nativeValue,
  });
  const firstBuyAmountIn =
    pair === WETH ? nativeValue : params.firstBuyPairIn;
  return {
    transaction: {
      transactionHash,
      to: TARGET,
      input: encodeFunctionData({
        abi: LAUNCH_ABI,
        functionName: "launch",
        args: [params],
      }),
      value: nativeValue,
    },
    receipt: {
      transactionHash,
      blockHash: `0x${String(index + 100).padStart(64, "0")}`,
      blockNumber,
      logs: [
        {
          address: TARGET,
          topics: encodeEventTopics({
            abi: TOKEN_LAUNCHED_ABI,
            eventName: "TokenLaunched",
            args: { token, creator: SENDER, feeVault: vault },
          }),
          data: encodeAbiParameters(
            [
              { type: "address" },
              { type: "string" },
              { type: "string" },
              { type: "string" },
              { type: "uint256" },
              { type: "address" },
              { type: "uint24" },
              { type: "int24" },
            ],
            [
              pool,
              name,
              symbol,
              metadataURI,
              BigInt(index + 1),
              pair,
              3000,
              floorTick,
            ],
          ),
        },
        {
          address: TARGET,
          topics: encodeEventTopics({
            abi: LAUNCH_PROVENANCE_ABI,
            eventName: "LaunchProvenanceRecorded",
            args: { token, configHash },
          }),
          data: encodeAbiParameters(
            [
              { type: "uint64" },
              { type: "uint256" },
              { type: "uint256" },
            ],
            [blockNumber, firstBuyAmountIn, 10_000n + BigInt(index)],
          ),
        },
      ],
    },
  };
}

function launchReceipts() {
  const evidence = [
    launchReceipt({
      index: 0,
      pair: WETH,
      floorTick: -276_300,
      name: "ZapPad WETH Canary",
      symbol: "ZPWC",
      metadataURI: "urn:zappad:canary:weth:v1",
      minFirstBuyTokensOut: 9_500n,
    }),
    launchReceipt({
      index: 1,
      pair: USDG,
      floorTick: -460_020,
      name: "ZapPad USDG Canary",
      symbol: "ZPUC",
      metadataURI: "urn:zappad:canary:usdg:v1",
      minFirstBuyTokensOut: 9_501n,
    }),
  ];
  return {
    receipts: evidence.map((item) => item.receipt),
    transactions: evidence.map((item) => item.transaction),
  };
}

function reviewedSequence(evidence, launches) {
  let syntheticHash = 1_000;
  const transaction = (to, input, value = 0n) => ({
    transactionHash: `0x${String(syntheticHash++).padStart(64, "0")}`,
    to,
    input,
    value,
  });
  const approval = (token, spender, amount) =>
    transaction(
      token,
      encodeFunctionData({
        abi: ERC20_WRITE_ABI,
        functionName: "approve",
        args: [spender, amount],
      }),
    );
  const swap = (tokenIn, tokenOut, amountIn, amountOutMinimum) =>
    transaction(
      ROUTER,
      encodeFunctionData({
        abi: ROUTER_WRITE_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            fee: 3000,
            recipient: SENDER,
            amountIn,
            amountOutMinimum,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    );
  const vaultCall = (vault, functionName, args = []) =>
    transaction(
      vault,
      encodeFunctionData({
        abi: VAULT_WRITE_ABI,
        functionName,
        args,
      }),
    );

  const transferLog = (token, from, to, value) => ({
    address: token,
    topics: encodeEventTopics({
      abi: ERC20_TRANSFER_ABI,
      eventName: "Transfer",
      args: { from, to },
    }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  });
  const transactions = [];
  const receipts = [];
  const append = (item, logs = []) => {
    transactions.push(item);
    receipts.push({
      transactionHash: item.transactionHash,
      logs,
    });
  };
  const appendLaunch = (item, receipt) => {
    transactions.push(item);
    receipts.push(receipt);
  };
  const reviewedPlan = { launches: {} };
  for (const [key, launchTransaction] of [
    ["weth", evidence.transactions[0]],
    ["usdg", evidence.transactions[1]],
  ]) {
    const launch = launches[key];
    const pair = key === "weth" ? WETH : USDG;
    const launchReceipt =
      key === "weth" ? evidence.receipts[0] : evidence.receipts[1];
    const firstSell = BigInt(launch.firstBuyAmountOut) / 4n;
    const firstSellPairOut = 1_000n;
    const secondBuy = firstSellPairOut / 2n;
    const secondBuyTokenOut = 800n;
    const secondSell = secondBuyTokenOut / 2n;
    const minimums = {
      minFirstSellPairOut: 950n,
      minSecondBuyTokenOut: 760n,
      minSecondSellPairOut: 380n,
    };
    reviewedPlan.launches[key] = {
      pair,
      token: launch.token,
      vault: launch.vault,
      pool: launch.pool,
      salt: launch.salt,
      firstBuyPairIn: BigInt(launch.firstBuyAmountIn),
      nativeValue: BigInt(launch.nativeValue),
      minFirstBuyTokenOut: BigInt(launch.minFirstBuyTokensOut),
      ...minimums,
    };

    if (key === "usdg") {
      append(approval(pair, TARGET, BigInt(launch.firstBuyAmountIn)));
    }
    appendLaunch(launchTransaction, launchReceipt);
    if (key === "usdg") append(approval(pair, TARGET, 0n));

    append(approval(launch.token, ROUTER, firstSell));
    append(
      swap(
        launch.token,
        pair,
        firstSell,
        minimums.minFirstSellPairOut,
      ),
      [transferLog(pair, launch.pool, SENDER, firstSellPairOut)],
    );
    append(approval(launch.token, ROUTER, 0n));
    append(vaultCall(launch.vault, "harvest"));
    append(
      vaultCall(launch.vault, "transfer", [
        TREASURY,
        10n * 10n ** 18n,
      ]),
    );

    append(approval(pair, ROUTER, secondBuy));
    append(
      swap(
        pair,
        launch.token,
        secondBuy,
        minimums.minSecondBuyTokenOut,
      ),
      [transferLog(launch.token, launch.pool, SENDER, secondBuyTokenOut)],
    );
    append(approval(pair, ROUTER, 0n));

    append(approval(launch.token, ROUTER, secondSell));
    append(
      swap(
        launch.token,
        pair,
        secondSell,
        minimums.minSecondSellPairOut,
      ),
      [transferLog(pair, launch.pool, SENDER, 400n)],
    );
    append(approval(launch.token, ROUTER, 0n));
    append(vaultCall(launch.vault, "harvest"));
    append(vaultCall(launch.vault, "claimAll", [SENDER]));
  }
  return { transactions, receipts, reviewedPlan };
}

function fixture(status = "0x1") {
  return {
    chain: 4663,
    commit: "abcdef1",
    transactions: [0, 1].map((nonce) => ({
      function: "approve(address,uint256)",
      transaction: {
        from: SENDER,
        to: TARGET,
        nonce: `0x${nonce.toString(16)}`,
        value: "0x0",
        input: "0x1234",
      },
    })),
    receipts: [0, 1].map((index) => ({
      status,
      from: SENDER,
      transactionHash: `0x${String(index + 1).padStart(64, "0")}`,
      blockHash: `0x${String(index + 10).padStart(64, "0")}`,
      blockNumber: `0x${(100 + index).toString(16)}`,
    })),
  };
}

describe("Forge broadcast evidence parsing", () => {
  it("accepts successful nonce-sequential receipt pairs", () => {
    const entries = parseForgeBroadcast(fixture(), {
      expectedSender: SENDER,
      expectedCommit: "abcdef1234567890",
      minimumTransactions: 2,
    });
    expect(entries.map((entry) => entry.nonce)).toEqual([0n, 1n]);
  });

  it("rejects a reverted receipt", () => {
    expect(() =>
      parseForgeBroadcast(fixture("0x0"), {
        expectedSender: SENDER,
        expectedCommit: "abcdef1234567890",
        minimumTransactions: 2,
      }),
    ).toThrow(/not successful/);
  });

  it("rejects a nonce gap", () => {
    const broadcast = fixture();
    broadcast.transactions[1].transaction.nonce = "0x2";
    expect(() =>
      parseForgeBroadcast(broadcast, {
        expectedSender: SENDER,
        expectedCommit: "abcdef1234567890",
        minimumTransactions: 2,
      }),
    ).toThrow(/nonce-sequential/);
  });

  it("binds exactly one canonical WETH and USDG launch event", () => {
    const evidence = launchReceipts();
    const launches = extractCanaryLaunches(evidence.receipts, {
      expectedLaunchpad: TARGET,
      expectedCreator: SENDER,
      transactions: evidence.transactions,
    });
    expect(launches.weth.pair).toBe(WETH);
    expect(launches.usdg.pair).toBe(USDG);
    expect(launches.weth.transactionHash).not.toBe(
      launches.usdg.transactionHash,
    );
  });

  it("rejects drift in canonical canary identity", () => {
    const evidence = launchReceipts();
    evidence.receipts[0] = launchReceipt({
      index: 0,
      pair: WETH,
      floorTick: -276_300,
      name: "Not the reviewed canary",
      symbol: "ZPWC",
      metadataURI: "urn:zappad:canary:weth:v1",
    }).receipt;
    expect(() =>
      extractCanaryLaunches(evidence.receipts, {
        expectedLaunchpad: TARGET,
        expectedCreator: SENDER,
        transactions: evidence.transactions,
      }),
    ).toThrow(/parameters changed/);
  });

  it("rejects provenance that is not bound to launch calldata", () => {
    const evidence = launchReceipts();
    evidence.transactions[0] = {
      ...evidence.transactions[0],
      value: 101n,
    };
    expect(() =>
      extractCanaryLaunches(evidence.receipts, {
        expectedLaunchpad: TARGET,
        expectedCreator: SENDER,
        transactions: evidence.transactions,
      }),
    ).toThrow(/provenance changed/);
  });

  it("rejects first buys above the versioned canary caps", () => {
    const wethEvidence = launchReceipts();
    const oversizedWeth = launchReceipt({
      index: 0,
      pair: WETH,
      floorTick: -276_300,
      name: "ZapPad WETH Canary",
      symbol: "ZPWC",
      metadataURI: "urn:zappad:canary:weth:v1",
      firstBuyAmount: 1_000_000_000_000_001n,
    });
    wethEvidence.receipts[0] = oversizedWeth.receipt;
    wethEvidence.transactions[0] = oversizedWeth.transaction;
    expect(() =>
      extractCanaryLaunches(wethEvidence.receipts, {
        expectedLaunchpad: TARGET,
        expectedCreator: SENDER,
        transactions: wethEvidence.transactions,
      }),
    ).toThrow(/launch safety policy changed/);

    const usdgEvidence = launchReceipts();
    const oversizedUsdg = launchReceipt({
      index: 1,
      pair: USDG,
      floorTick: -460_020,
      name: "ZapPad USDG Canary",
      symbol: "ZPUC",
      metadataURI: "urn:zappad:canary:usdg:v1",
      firstBuyAmount: 10_000_001n,
    });
    usdgEvidence.receipts[1] = oversizedUsdg.receipt;
    usdgEvidence.transactions[1] = oversizedUsdg.transaction;
    expect(() =>
      extractCanaryLaunches(usdgEvidence.receipts, {
        expectedLaunchpad: TARGET,
        expectedCreator: SENDER,
        transactions: usdgEvidence.transactions,
      }),
    ).toThrow(/launch safety policy changed/);
  });

  it("rejects a zero minimum output in reviewed canary calldata", () => {
    const evidence = launchReceipts();
    const unprotected = launchReceipt({
      index: 0,
      pair: WETH,
      floorTick: -276_300,
      name: "ZapPad WETH Canary",
      symbol: "ZPWC",
      metadataURI: "urn:zappad:canary:weth:v1",
      minFirstBuyTokensOut: 0n,
    });
    evidence.receipts[0] = unprotected.receipt;
    evidence.transactions[0] = unprotected.transaction;
    expect(() =>
      extractCanaryLaunches(evidence.receipts, {
        expectedLaunchpad: TARGET,
        expectedCreator: SENDER,
        transactions: evidence.transactions,
      }),
    ).toThrow(/launch safety policy changed/);
  });

  it("accepts only the exact reviewed 30-call creator sequence", () => {
    const evidence = launchReceipts();
    const launches = extractCanaryLaunches(evidence.receipts, {
      expectedLaunchpad: TARGET,
      expectedCreator: SENDER,
      transactions: evidence.transactions,
    });
    const { transactions, receipts, reviewedPlan } = reviewedSequence(
      evidence,
      launches,
    );
    expect(transactions).toHaveLength(30);
    expect(() =>
      validateCanaryTransactionSequence(transactions, {
        expectedLaunchpad: TARGET,
        expectedCreator: SENDER,
        expectedTreasury: TREASURY,
        launches,
        receipts,
        reviewedPlan,
      }),
    ).not.toThrow();
  });

  it("rejects an extra successful creator transaction", () => {
    const evidence = launchReceipts();
    const launches = extractCanaryLaunches(evidence.receipts, {
      expectedLaunchpad: TARGET,
      expectedCreator: SENDER,
      transactions: evidence.transactions,
    });
    const { transactions, receipts, reviewedPlan } = reviewedSequence(
      evidence,
      launches,
    );
    transactions.push({
      ...transactions[0],
      transactionHash: `0x${"f".repeat(64)}`,
    });
    receipts.push({
      transactionHash: transactions.at(-1).transactionHash,
      logs: [],
    });
    expect(() =>
      validateCanaryTransactionSequence(transactions, {
        expectedLaunchpad: TARGET,
        expectedCreator: SENDER,
        expectedTreasury: TREASURY,
        launches,
        receipts,
        reviewedPlan,
      }),
    ).toThrow(/exactly 30 reviewed calls/);
  });

  it("rejects calldata drift inside an otherwise valid sequence", () => {
    const evidence = launchReceipts();
    const launches = extractCanaryLaunches(evidence.receipts, {
      expectedLaunchpad: TARGET,
      expectedCreator: SENDER,
      transactions: evidence.transactions,
    });
    const { transactions, receipts, reviewedPlan } = reviewedSequence(
      evidence,
      launches,
    );
    transactions[5] = {
      ...transactions[5],
      input: encodeFunctionData({
        abi: VAULT_WRITE_ABI,
        functionName: "transfer",
        args: [SENDER, 10n * 10n ** 18n],
      }),
    };
    expect(() =>
      validateCanaryTransactionSequence(transactions, {
        expectedLaunchpad: TARGET,
        expectedCreator: SENDER,
        expectedTreasury: TREASURY,
        launches,
        receipts,
        reviewedPlan,
      }),
    ).toThrow(/fee-share transfer/);
  });

  it("rejects matching approval and swap calldata with an arbitrary ratio", () => {
    const evidence = launchReceipts();
    const launches = extractCanaryLaunches(evidence.receipts, {
      expectedLaunchpad: TARGET,
      expectedCreator: SENDER,
      transactions: evidence.transactions,
    });
    const { transactions, receipts, reviewedPlan } = reviewedSequence(
      evidence,
      launches,
    );
    const arbitraryFirstSell = 2_499n;
    transactions[1] = {
      ...transactions[1],
      input: encodeFunctionData({
        abi: ERC20_WRITE_ABI,
        functionName: "approve",
        args: [ROUTER, arbitraryFirstSell],
      }),
    };
    transactions[2] = {
      ...transactions[2],
      input: encodeFunctionData({
        abi: ROUTER_WRITE_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: launches.weth.token,
            tokenOut: WETH,
            fee: 3000,
            recipient: SENDER,
            amountIn: arbitraryFirstSell,
            amountOutMinimum:
              reviewedPlan.launches.weth.minFirstSellPairOut,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    };

    expect(() =>
      validateCanaryTransactionSequence(transactions, {
        expectedLaunchpad: TARGET,
        expectedCreator: SENDER,
        expectedTreasury: TREASURY,
        launches,
        receipts,
        reviewedPlan,
      }),
    ).toThrow(/first-sell input changed from the reviewed canary ratio/);
  });

  it("rejects a one-unit swap minimum even when the call otherwise matches", () => {
    const evidence = launchReceipts();
    const launches = extractCanaryLaunches(evidence.receipts, {
      expectedLaunchpad: TARGET,
      expectedCreator: SENDER,
      transactions: evidence.transactions,
    });
    const { transactions, receipts, reviewedPlan } = reviewedSequence(
      evidence,
      launches,
    );
    transactions[2] = {
      ...transactions[2],
      input: encodeFunctionData({
        abi: ROUTER_WRITE_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: launches.weth.token,
            tokenOut: WETH,
            fee: 3000,
            recipient: SENDER,
            amountIn: BigInt(launches.weth.firstBuyAmountOut) / 4n,
            amountOutMinimum: 1n,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    };

    expect(() =>
      validateCanaryTransactionSequence(transactions, {
        expectedLaunchpad: TARGET,
        expectedCreator: SENDER,
        expectedTreasury: TREASURY,
        launches,
        receipts,
        reviewedPlan,
      }),
    ).toThrow(/changed the reviewed WETH first sell/);
  });
});
