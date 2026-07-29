import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  isAddress,
  isHash,
  keccak256,
  parseAbi,
  toBytes,
} from "viem";

const EXPECTED_CHAIN_ID = 4663;
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const SWAP_ROUTER = getAddress("0xCaf681a66D020601342297493863E78C959E5cb2");
const MAX_WETH_FIRST_BUY = 1_000_000_000_000_000n;
const MAX_USDG_FIRST_BUY = 10_000_000n;
export const CANARY_POLICY_TEXT =
  "ZapPadCanaryPolicy:v4;maxWethFirstBuyWei=1000000000000000;maxUsdgFirstBuy=10000000;maxReviewedSlippageBps=500;reviewedPlanHash=required;deploymentVerificationEvidenceHash=required;exactVerificationBlockHashReadback=required;ratios=firstSell:1/4,secondBuy:1/2,secondSell:1/2;creatorTransactionSequence=weth14+usdg16";
export const CANARY_POLICY_HASH = keccak256(toBytes(CANARY_POLICY_TEXT));
export const CANARY_POLICY = Object.freeze({
  schema: "zappad-canary-policy/v4",
  maxWethFirstBuyWei: MAX_WETH_FIRST_BUY.toString(),
  maxUsdgFirstBuy: MAX_USDG_FIRST_BUY.toString(),
  maxReviewedSlippageBps: 500,
  requireReviewedPlanHash: true,
  requireDeploymentVerificationEvidenceHash: true,
  requireExactVerificationBlockHashReadback: true,
  canaryRatios: {
    firstSellFromFirstBuy: "1/4",
    secondBuyFromFirstSell: "1/2",
    secondSellFromSecondBuy: "1/2",
  },
  creatorTransactionCount: 30,
  creatorTransactionSequence: "weth14+usdg16",
});
export const TOKEN_LAUNCHED_ABI = parseAbi([
  "event TokenLaunched(address indexed token,address indexed creator,address indexed feeVault,address pool,string name,string symbol,string metadataURI,uint256 positionId,address pairedAsset,uint24 feeTier,int24 floorTick)",
]);
export const LAUNCH_PROVENANCE_ABI = parseAbi([
  "event LaunchProvenanceRecorded(address indexed token,bytes32 indexed configHash,uint64 launchedAt,uint256 firstBuyAmountIn,uint256 firstBuyAmountOut)",
  "function launchProvenance(address token) view returns (bytes32 configHash,uint64 launchedAt,uint256 firstBuyAmountIn,uint256 firstBuyAmountOut)",
]);
export const LAUNCH_ABI = parseAbi([
  "function launch((string name,string symbol,string metadataURI,bytes32 salt,int24 floorTick,address pairedAsset,uint24 feeTier,uint256 firstBuyPairIn,uint256 minFirstBuyTokensOut) p) payable returns (address token,address feeVault)",
]);
const ERC20_WRITE_ABI = parseAbi([
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const ROUTER_WRITE_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const VAULT_WRITE_ABI = parseAbi([
  "function harvest() returns (uint256 harvestedLaunchToken,uint256 harvestedPairedAsset)",
  "function transfer(address to,uint256 value) returns (bool)",
  "function claimAll(address recipient) returns (uint256 launchTokenAmount,uint256 pairedAssetAmount)",
]);
const CANARY_EVENT_ABI = [...TOKEN_LAUNCHED_ABI, ...LAUNCH_PROVENANCE_ABI];
const ERC20_TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const LAUNCH_CONFIG_DOMAIN = keccak256(toBytes("ZapPadLaunchConfig:v1"));
const LAUNCH_CONFIG_TUPLE = {
  type: "tuple",
  components: [
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "metadataURI", type: "string" },
    { name: "salt", type: "bytes32" },
    { name: "floorTick", type: "int24" },
    { name: "pairedAsset", type: "address" },
    { name: "feeTier", type: "uint24" },
    { name: "firstBuyPairIn", type: "uint256" },
    { name: "minFirstBuyTokensOut", type: "uint256" },
  ],
};
const EXPECTED_CANARIES = {
  weth: {
    pair: WETH,
    floorTick: -276_300,
    name: "ZapPad WETH Canary",
    symbol: "ZPWC",
    metadataURI: "urn:zappad:canary:weth:v1",
  },
  usdg: {
    pair: USDG,
    floorTick: -460_020,
    name: "ZapPad USDG Canary",
    symbol: "ZPUC",
    metadataURI: "urn:zappad:canary:usdg:v1",
  },
};

function hexInteger(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} is not a hex integer`);
  }
  return BigInt(value);
}

function sameAddress(left, right) {
  return getAddress(left) === getAddress(right);
}

export function computeLaunchConfigHash({
  launchpad,
  creator,
  params,
  nativeValue,
}) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        LAUNCH_CONFIG_TUPLE,
        { type: "uint256" },
      ],
      [
        LAUNCH_CONFIG_DOMAIN,
        BigInt(EXPECTED_CHAIN_ID),
        getAddress(launchpad),
        getAddress(creator),
        params,
        nativeValue,
      ],
    ),
  );
}

export function parseForgeBroadcast(
  broadcast,
  { expectedSender, expectedCommit, minimumTransactions = 20 },
) {
  if (Number(broadcast.chain) !== EXPECTED_CHAIN_ID) {
    throw new Error(`Broadcast chain must be ${EXPECTED_CHAIN_ID}`);
  }
  if (!isAddress(expectedSender)) {
    throw new Error("Expected broadcast sender is invalid");
  }
  if (
    typeof broadcast.commit !== "string" ||
    !/^[0-9a-f]{7,40}$/i.test(broadcast.commit) ||
    typeof expectedCommit !== "string" ||
    !/^[0-9a-f]{7,40}$/i.test(expectedCommit) ||
    !expectedCommit.toLowerCase().startsWith(broadcast.commit.toLowerCase())
  ) {
    throw new Error("Broadcast commit does not match the reviewed release commit");
  }

  const transactions = broadcast.transactions;
  const receipts = broadcast.receipts;
  if (
    !Array.isArray(transactions) ||
    !Array.isArray(receipts) ||
    transactions.length !== receipts.length ||
    transactions.length < minimumTransactions
  ) {
    throw new Error(
      `Broadcast must contain at least ${minimumTransactions} matched transactions and receipts`,
    );
  }

  let previousNonce = null;
  return transactions.map((entry, index) => {
    const transaction = entry?.transaction;
    const receipt = receipts[index];
    if (!transaction || !receipt) {
      throw new Error(`Broadcast entry ${index} is incomplete`);
    }
    if (
      !isAddress(transaction.from) ||
      !isAddress(receipt.from) ||
      !sameAddress(transaction.from, expectedSender) ||
      !sameAddress(receipt.from, expectedSender)
    ) {
      throw new Error(`Broadcast entry ${index} has the wrong sender`);
    }
    if (hexInteger(receipt.status, `Receipt ${index} status`) !== 1n) {
      throw new Error(`Broadcast receipt ${index} was not successful`);
    }
    if (!isHash(receipt.transactionHash) || !isHash(receipt.blockHash)) {
      throw new Error(`Broadcast receipt ${index} has invalid hashes`);
    }

    const nonce = hexInteger(transaction.nonce, `Transaction ${index} nonce`);
    if (previousNonce != null && nonce !== previousNonce + 1n) {
      throw new Error(`Broadcast transaction ${index} is not nonce-sequential`);
    }
    previousNonce = nonce;

    const input = transaction.input;
    if (typeof input !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input)) {
      throw new Error(`Broadcast transaction ${index} has invalid calldata`);
    }
    const to =
      transaction.to == null
        ? null
        : isAddress(transaction.to)
          ? getAddress(transaction.to)
          : (() => {
              throw new Error(`Broadcast transaction ${index} has invalid target`);
            })();

    return {
      index,
      transactionHash: receipt.transactionHash.toLowerCase(),
      blockHash: receipt.blockHash.toLowerCase(),
      blockNumber: hexInteger(
        receipt.blockNumber,
        `Receipt ${index} block number`,
      ),
      nonce,
      from: getAddress(transaction.from),
      to,
      value: hexInteger(transaction.value, `Transaction ${index} value`),
      input: input.toLowerCase(),
      function: typeof entry.function === "string" ? entry.function : null,
    };
  });
}

export function extractCanaryLaunches(
  receipts,
  { expectedLaunchpad, expectedCreator, transactions },
) {
  if (!isAddress(expectedLaunchpad) || !isAddress(expectedCreator)) {
    throw new Error("Expected launchpad and creator must be valid addresses");
  }

  const launchpad = getAddress(expectedLaunchpad);
  const creator = getAddress(expectedCreator);
  if (!Array.isArray(transactions)) {
    throw new Error("Verified canary transactions are required");
  }
  const transactionsByHash = new Map(
    transactions.map((transaction) => [
      transaction.transactionHash.toLowerCase(),
      transaction,
    ]),
  );
  const observed = [];
  const observedProvenance = [];
  for (const receipt of receipts) {
    if (
      !isHash(receipt.transactionHash) ||
      !isHash(receipt.blockHash) ||
      typeof receipt.blockNumber !== "bigint" ||
      !Array.isArray(receipt.logs)
    ) {
      throw new Error("Live canary receipt is incomplete");
    }
    for (const log of receipt.logs) {
      if (!isAddress(log.address) || !sameAddress(log.address, launchpad)) {
        continue;
      }
      try {
        const event = decodeEventLog({
          abi: CANARY_EVENT_ABI,
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (event.eventName === "TokenLaunched") {
          observed.push({
            token: getAddress(event.args.token),
            creator: getAddress(event.args.creator),
            vault: getAddress(event.args.feeVault),
            pool: getAddress(event.args.pool),
            name: event.args.name,
            symbol: event.args.symbol,
            metadataURI: event.args.metadataURI,
            positionId: event.args.positionId,
            pair: getAddress(event.args.pairedAsset),
            feeTier: Number(event.args.feeTier),
            floorTick: Number(event.args.floorTick),
            transactionHash: receipt.transactionHash.toLowerCase(),
            blockHash: receipt.blockHash.toLowerCase(),
            blockNumber: receipt.blockNumber,
          });
        }
        if (event.eventName === "LaunchProvenanceRecorded") {
          observedProvenance.push({
            token: getAddress(event.args.token),
            configHash: event.args.configHash,
            launchedAt: event.args.launchedAt,
            firstBuyAmountIn: event.args.firstBuyAmountIn,
            firstBuyAmountOut: event.args.firstBuyAmountOut,
            transactionHash: receipt.transactionHash.toLowerCase(),
          });
        }
      } catch {
        // Ignore unrelated logs emitted by the launchpad.
      }
    }
  }

  if (observed.length !== 2) {
    throw new Error("Broadcast must emit exactly two TokenLaunched events");
  }
  if (observedProvenance.length !== 2) {
    throw new Error(
      "Broadcast must emit exactly two LaunchProvenanceRecorded events",
    );
  }

  const result = {};
  for (const [key, expected] of Object.entries(EXPECTED_CANARIES)) {
    const matches = observed.filter((record) =>
      sameAddress(record.pair, expected.pair),
    );
    if (matches.length !== 1) {
      throw new Error(`Broadcast must contain exactly one ${key.toUpperCase()} canary`);
    }
    const record = matches[0];
    if (
      !sameAddress(record.creator, creator) ||
      record.feeTier !== 3000 ||
      record.floorTick !== expected.floorTick ||
      record.name !== expected.name ||
      record.symbol !== expected.symbol ||
      record.metadataURI !== expected.metadataURI ||
      record.positionId <= 0n
    ) {
      throw new Error(`${key.toUpperCase()} canary launch parameters changed`);
    }
    const transaction = transactionsByHash.get(record.transactionHash);
    if (
      !transaction ||
      !transaction.to ||
      !sameAddress(transaction.to, launchpad) ||
      typeof transaction.input !== "string" ||
      typeof transaction.value !== "bigint"
    ) {
      throw new Error(`${key.toUpperCase()} launch transaction is missing`);
    }
    let params;
    try {
      const decoded = decodeFunctionData({
        abi: LAUNCH_ABI,
        data: transaction.input,
      });
      if (decoded.functionName !== "launch") {
        throw new Error("wrong function");
      }
      [params] = decoded.args;
    } catch {
      throw new Error(`${key.toUpperCase()} launch calldata is invalid`);
    }
    if (
      params.name !== record.name ||
      params.symbol !== record.symbol ||
      params.metadataURI !== record.metadataURI ||
      !sameAddress(params.pairedAsset, record.pair) ||
      Number(params.feeTier) !== record.feeTier ||
      Number(params.floorTick) !== record.floorTick
    ) {
      throw new Error(`${key.toUpperCase()} event does not match launch calldata`);
    }
    const provenanceMatches = observedProvenance.filter(
      (provenance) =>
        sameAddress(provenance.token, record.token) &&
        provenance.transactionHash === record.transactionHash,
    );
    if (provenanceMatches.length !== 1) {
      throw new Error(`${key.toUpperCase()} launch provenance is not unique`);
    }
    const provenance = provenanceMatches[0];
    const expectedConfigHash = computeLaunchConfigHash({
      launchpad,
      creator,
      params,
      nativeValue: transaction.value,
    });
    const expectedFirstBuyIn = sameAddress(record.pair, WETH)
      ? transaction.value
      : params.firstBuyPairIn;
    const isWethCanary = sameAddress(record.pair, WETH);
    if (
      params.minFirstBuyTokensOut <= 0n ||
      (isWethCanary &&
        (transaction.value <= 0n ||
          transaction.value > MAX_WETH_FIRST_BUY ||
          params.firstBuyPairIn !== 0n)) ||
      (!isWethCanary &&
        (transaction.value !== 0n ||
          params.firstBuyPairIn <= 0n ||
          params.firstBuyPairIn > MAX_USDG_FIRST_BUY))
    ) {
      throw new Error(`${key.toUpperCase()} launch safety policy changed`);
    }
    if (
      provenance.configHash.toLowerCase() !==
        expectedConfigHash.toLowerCase() ||
      provenance.launchedAt <= 0n ||
      provenance.firstBuyAmountIn !== expectedFirstBuyIn ||
      provenance.firstBuyAmountOut < params.minFirstBuyTokensOut ||
      provenance.firstBuyAmountOut <= 0n
    ) {
      throw new Error(`${key.toUpperCase()} launch provenance changed`);
    }
    result[key] = {
      ...record,
      configHash: provenance.configHash,
      launchedAt: provenance.launchedAt.toString(),
      firstBuyAmountIn: provenance.firstBuyAmountIn.toString(),
      firstBuyAmountOut: provenance.firstBuyAmountOut.toString(),
      minFirstBuyTokensOut: params.minFirstBuyTokensOut.toString(),
      nativeValue: transaction.value.toString(),
      salt: params.salt,
      positionId: record.positionId.toString(),
      blockNumber: record.blockNumber.toString(),
    };
  }

  const weth = result.weth;
  const usdg = result.usdg;
  if (
    sameAddress(weth.token, usdg.token) ||
    sameAddress(weth.vault, usdg.vault) ||
    sameAddress(weth.pool, usdg.pool) ||
    weth.positionId === usdg.positionId ||
    weth.transactionHash === usdg.transactionHash
  ) {
    throw new Error("Canary launch records must be distinct");
  }

  return result;
}

function requireTransaction(
  transactions,
  index,
  { target, value = 0n, label },
) {
  const transaction = transactions[index];
  if (
    !transaction ||
    !transaction.to ||
    !sameAddress(transaction.to, target) ||
    transaction.value !== value
  ) {
    throw new Error(`Canary transaction ${index} is not the reviewed ${label}`);
  }
  return transaction;
}

function decodeReviewedCall(transaction, abi, functionName, index, label) {
  try {
    const decoded = decodeFunctionData({ abi, data: transaction.input });
    if (decoded.functionName !== functionName) throw new Error("wrong function");
    return decoded.args ?? [];
  } catch {
    throw new Error(`Canary transaction ${index} has invalid ${label} calldata`);
  }
}

function requireApproval(
  transactions,
  index,
  { token, spender, amount, label },
) {
  const transaction = requireTransaction(transactions, index, {
    target: token,
    label,
  });
  const [recordedSpender, recordedAmount] = decodeReviewedCall(
    transaction,
    ERC20_WRITE_ABI,
    "approve",
    index,
    label,
  );
  if (
    !sameAddress(recordedSpender, spender) ||
    recordedAmount !== amount
  ) {
    throw new Error(`Canary transaction ${index} changed the reviewed ${label}`);
  }
}

function requireSwap(
  transactions,
  index,
  {
    tokenIn,
    tokenOut,
    recipient,
    amountIn,
    minimumOut,
    pairInputCap,
    label,
  },
) {
  const transaction = requireTransaction(transactions, index, {
    target: SWAP_ROUTER,
    label,
  });
  const [params] = decodeReviewedCall(
    transaction,
    ROUTER_WRITE_ABI,
    "exactInputSingle",
    index,
    label,
  );
  if (
    !sameAddress(params.tokenIn, tokenIn) ||
    !sameAddress(params.tokenOut, tokenOut) ||
    !sameAddress(params.recipient, recipient) ||
    Number(params.fee) !== 3000 ||
    params.amountIn !== amountIn ||
    params.amountIn <= 0n ||
    params.amountOutMinimum !== minimumOut ||
    params.amountOutMinimum <= 0n ||
    params.sqrtPriceLimitX96 !== 0n ||
    (pairInputCap != null && params.amountIn > pairInputCap)
  ) {
    throw new Error(`Canary transaction ${index} changed the reviewed ${label}`);
  }
}

function requireVaultCall(
  transactions,
  index,
  { vault, functionName, args, label },
) {
  const transaction = requireTransaction(transactions, index, {
    target: vault,
    label,
  });
  const recordedArgs = decodeReviewedCall(
    transaction,
    VAULT_WRITE_ABI,
    functionName,
    index,
    label,
  );
  if (
    recordedArgs.length !== args.length ||
    recordedArgs.some((value, argumentIndex) => {
      const expected = args[argumentIndex];
      if (typeof expected === "string" && isAddress(expected)) {
        return !sameAddress(value, expected);
      }
      return value !== expected;
    })
  ) {
    throw new Error(`Canary transaction ${index} changed the reviewed ${label}`);
  }
}

function requireReceipt(receipts, transaction, index, label) {
  const receipt = receipts[index];
  if (
    !receipt ||
    !isHash(receipt.transactionHash) ||
    receipt.transactionHash.toLowerCase() !==
      transaction.transactionHash.toLowerCase() ||
    !Array.isArray(receipt.logs)
  ) {
    throw new Error(`Canary transaction ${index} lacks its live ${label} receipt`);
  }
  return receipt;
}

function receivedTokenAmount(receipt, token, recipient, label) {
  let amount = 0n;
  for (const log of receipt.logs) {
    if (!isAddress(log.address) || !sameAddress(log.address, token)) continue;
    try {
      const event = decodeEventLog({
        abi: ERC20_TRANSFER_ABI,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (
        event.eventName === "Transfer" &&
        sameAddress(event.args.to, recipient)
      ) {
        amount += event.args.value;
      }
    } catch {
      // Ignore unrelated logs from the output-token contract.
    }
  }
  if (amount <= 0n) {
    throw new Error(`${label} receipt has no output-token transfer to the creator`);
  }
  return amount;
}

function requireRatio(actual, expected, label) {
  if (actual !== expected || actual <= 0n) {
    throw new Error(`${label} changed from the reviewed canary ratio`);
  }
}

/**
 * Rejects every creator transaction that is not one of the exact calls emitted
 * by PrepareZapPadCanaries. This is intentionally stricter than an allowlist:
 * order, target, native value, arguments, approval cleanup, and total count are
 * all part of the reviewed release evidence.
 */
export function validateCanaryTransactionSequence(
  transactions,
  {
    expectedLaunchpad,
    expectedCreator,
    expectedTreasury,
    launches,
    receipts,
    reviewedPlan,
  },
) {
  if (
    !Array.isArray(transactions) ||
    !Array.isArray(receipts) ||
    receipts.length !== transactions.length ||
    !isAddress(expectedLaunchpad) ||
    !isAddress(expectedCreator) ||
    !isAddress(expectedTreasury) ||
    !launches?.weth ||
    !launches?.usdg ||
    !reviewedPlan?.launches?.weth ||
    !reviewedPlan?.launches?.usdg
  ) {
    throw new Error("Complete canary transaction policy inputs are required");
  }

  const launchpad = getAddress(expectedLaunchpad);
  const creator = getAddress(expectedCreator);
  const treasury = getAddress(expectedTreasury);
  let index = 0;

  for (const key of ["weth", "usdg"]) {
    const launch = launches[key];
    const reviewed = reviewedPlan.launches[key];
    const pair = key === "weth" ? WETH : USDG;
    const pairInputCap =
      key === "weth" ? MAX_WETH_FIRST_BUY : MAX_USDG_FIRST_BUY;

    if (
      !sameAddress(launch.pair, pair) ||
      !sameAddress(reviewed.pair, pair) ||
      !sameAddress(launch.token, reviewed.token) ||
      !sameAddress(launch.vault, reviewed.vault) ||
      !sameAddress(launch.pool, reviewed.pool) ||
      launch.salt.toLowerCase() !== reviewed.salt.toLowerCase() ||
      BigInt(launch.firstBuyAmountIn) !== reviewed.firstBuyPairIn ||
      BigInt(launch.nativeValue) !== reviewed.nativeValue ||
      BigInt(launch.minFirstBuyTokensOut) !==
        reviewed.minFirstBuyTokenOut
    ) {
      throw new Error(`${key.toUpperCase()} canary changed from the reviewed plan`);
    }

    if (key === "usdg") {
      requireApproval(transactions, index, {
        token: pair,
        spender: launchpad,
        amount: BigInt(launch.firstBuyAmountIn),
        label: "USDG launch approval",
      });
      index += 1;
    }

    const launchTransaction = requireTransaction(transactions, index, {
      target: launchpad,
      value: BigInt(launch.nativeValue),
      label: `${key.toUpperCase()} launch`,
    });
    if (
      launchTransaction.transactionHash.toLowerCase() !==
      launch.transactionHash.toLowerCase()
    ) {
      throw new Error(`Canary transaction ${index} is not the observed ${key.toUpperCase()} launch`);
    }
    index += 1;

    if (key === "usdg") {
      requireApproval(transactions, index, {
        token: pair,
        spender: launchpad,
        amount: 0n,
        label: "USDG launch approval cleanup",
      });
      index += 1;
    }

    const firstSellApproval = requireTransaction(transactions, index, {
      target: launch.token,
      label: `${key.toUpperCase()} first-sell approval`,
    });
    const [firstSellSpender, firstSellAmount] = decodeReviewedCall(
      firstSellApproval,
      ERC20_WRITE_ABI,
      "approve",
      index,
      `${key.toUpperCase()} first-sell approval`,
    );
    if (
      !sameAddress(firstSellSpender, SWAP_ROUTER) ||
      firstSellAmount <= 0n
    ) {
      throw new Error(`Canary transaction ${index} changed the reviewed first-sell approval`);
    }
    requireRatio(
      firstSellAmount,
      BigInt(launch.firstBuyAmountOut) / 4n,
      `${key.toUpperCase()} first-sell input`,
    );
    index += 1;
    const firstSellTransaction = transactions[index];
    requireSwap(transactions, index, {
      tokenIn: launch.token,
      tokenOut: pair,
      recipient: creator,
      amountIn: firstSellAmount,
      minimumOut: reviewed.minFirstSellPairOut,
      label: `${key.toUpperCase()} first sell`,
    });
    const firstSellPairOut = receivedTokenAmount(
      requireReceipt(
        receipts,
        firstSellTransaction,
        index,
        `${key.toUpperCase()} first-sell`,
      ),
      pair,
      creator,
      `${key.toUpperCase()} first sell`,
    );
    if (firstSellPairOut < reviewed.minFirstSellPairOut) {
      throw new Error(
        `${key.toUpperCase()} first-sell receipt is below the reviewed minimum`,
      );
    }
    index += 1;
    requireApproval(transactions, index, {
      token: launch.token,
      spender: SWAP_ROUTER,
      amount: 0n,
      label: `${key.toUpperCase()} first-sell approval cleanup`,
    });
    index += 1;
    requireVaultCall(transactions, index, {
      vault: launch.vault,
      functionName: "harvest",
      args: [],
      label: `${key.toUpperCase()} first harvest`,
    });
    index += 1;
    requireVaultCall(transactions, index, {
      vault: launch.vault,
      functionName: "transfer",
      args: [treasury, 10n * 10n ** 18n],
      label: `${key.toUpperCase()} fee-share transfer`,
    });
    index += 1;

    const secondBuyApproval = requireTransaction(transactions, index, {
      target: pair,
      label: `${key.toUpperCase()} second-buy approval`,
    });
    const [secondBuySpender, secondBuyAmount] = decodeReviewedCall(
      secondBuyApproval,
      ERC20_WRITE_ABI,
      "approve",
      index,
      `${key.toUpperCase()} second-buy approval`,
    );
    if (
      !sameAddress(secondBuySpender, SWAP_ROUTER) ||
      secondBuyAmount <= 0n ||
      secondBuyAmount > pairInputCap
    ) {
      throw new Error(`Canary transaction ${index} changed the reviewed second-buy approval`);
    }
    requireRatio(
      secondBuyAmount,
      firstSellPairOut / 2n,
      `${key.toUpperCase()} second-buy input`,
    );
    index += 1;
    const secondBuyTransaction = transactions[index];
    requireSwap(transactions, index, {
      tokenIn: pair,
      tokenOut: launch.token,
      recipient: creator,
      amountIn: secondBuyAmount,
      minimumOut: reviewed.minSecondBuyTokenOut,
      pairInputCap,
      label: `${key.toUpperCase()} second buy`,
    });
    const secondBuyTokenOut = receivedTokenAmount(
      requireReceipt(
        receipts,
        secondBuyTransaction,
        index,
        `${key.toUpperCase()} second-buy`,
      ),
      launch.token,
      creator,
      `${key.toUpperCase()} second buy`,
    );
    if (secondBuyTokenOut < reviewed.minSecondBuyTokenOut) {
      throw new Error(
        `${key.toUpperCase()} second-buy receipt is below the reviewed minimum`,
      );
    }
    index += 1;
    requireApproval(transactions, index, {
      token: pair,
      spender: SWAP_ROUTER,
      amount: 0n,
      label: `${key.toUpperCase()} second-buy approval cleanup`,
    });
    index += 1;

    const secondSellApproval = requireTransaction(transactions, index, {
      target: launch.token,
      label: `${key.toUpperCase()} second-sell approval`,
    });
    const [secondSellSpender, secondSellAmount] = decodeReviewedCall(
      secondSellApproval,
      ERC20_WRITE_ABI,
      "approve",
      index,
      `${key.toUpperCase()} second-sell approval`,
    );
    if (
      !sameAddress(secondSellSpender, SWAP_ROUTER) ||
      secondSellAmount <= 0n
    ) {
      throw new Error(`Canary transaction ${index} changed the reviewed second-sell approval`);
    }
    requireRatio(
      secondSellAmount,
      secondBuyTokenOut / 2n,
      `${key.toUpperCase()} second-sell input`,
    );
    index += 1;
    requireSwap(transactions, index, {
      tokenIn: launch.token,
      tokenOut: pair,
      recipient: creator,
      amountIn: secondSellAmount,
      minimumOut: reviewed.minSecondSellPairOut,
      label: `${key.toUpperCase()} second sell`,
    });
    index += 1;
    requireApproval(transactions, index, {
      token: launch.token,
      spender: SWAP_ROUTER,
      amount: 0n,
      label: `${key.toUpperCase()} second-sell approval cleanup`,
    });
    index += 1;
    requireVaultCall(transactions, index, {
      vault: launch.vault,
      functionName: "harvest",
      args: [],
      label: `${key.toUpperCase()} second harvest`,
    });
    index += 1;
    requireVaultCall(transactions, index, {
      vault: launch.vault,
      functionName: "claimAll",
      args: [creator],
      label: `${key.toUpperCase()} creator claim`,
    });
    index += 1;
  }

  if (index !== 30 || transactions.length !== index) {
    throw new Error(
      `Canary creator transaction sequence must contain exactly 30 reviewed calls; received ${transactions.length}`,
    );
  }
}
