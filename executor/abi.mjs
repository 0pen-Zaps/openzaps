// Minimal ABI surface the executor needs. Mirrors contracts/src/v3 exactly — if the contracts
// change, regenerate these fragments from `forge inspect OpenZapV3 abi`.

export const recurringIntentComponents = [
  { name: "zap", type: "address" },
  { name: "chainId", type: "uint256" },
  { name: "seriesId", type: "uint256" },
  { name: "validAfter", type: "uint64" },
  { name: "deadline", type: "uint64" },
  { name: "interval", type: "uint64" },
  { name: "maxRuns", type: "uint32" },
  { name: "recipient", type: "address" },
  { name: "executor", type: "address" },
  { name: "maxGas", type: "uint256" },
  { name: "maxFeePerGas", type: "uint256" },
  { name: "policyHash", type: "bytes32" },
  { name: "outAsset", type: "address" },
  { name: "minOutPerRun", type: "uint256" },
];

export const triggerIntentComponents = [
  { name: "zap", type: "address" },
  { name: "chainId", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "validAfter", type: "uint64" },
  { name: "deadline", type: "uint64" },
  { name: "priceSource", type: "address" },
  { name: "baselinePriceX96", type: "uint256" },
  { name: "thresholdBps", type: "uint32" },
  { name: "above", type: "bool" },
  { name: "recipient", type: "address" },
  { name: "executor", type: "address" },
  { name: "maxGas", type: "uint256" },
  { name: "maxFeePerGas", type: "uint256" },
  { name: "policyHash", type: "bytes32" },
  { name: "outAsset", type: "address" },
  { name: "minOut", type: "uint256" },
];

// Custom errors included so simulation reverts decode to readable names in logs.
const openZapV3Errors = [
  { type: "error", name: "WrongZap", inputs: [] },
  { type: "error", name: "WrongChain", inputs: [] },
  { type: "error", name: "PolicyMismatch", inputs: [] },
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "NotYetValid", inputs: [] },
  { type: "error", name: "GasPriceTooHigh", inputs: [] },
  { type: "error", name: "GasLimitTooHigh", inputs: [] },
  { type: "error", name: "WrongRecipient", inputs: [] },
  { type: "error", name: "NonceReplay", inputs: [] },
  { type: "error", name: "BadSignature", inputs: [] },
  { type: "error", name: "MinOutNotMet", inputs: [] },
  { type: "error", name: "InvalidSchedule", inputs: [] },
  { type: "error", name: "IntervalNotElapsed", inputs: [{ name: "nextRunAt", type: "uint64" }] },
  { type: "error", name: "ExecutorMismatch", inputs: [] },
  { type: "error", name: "PriceSourceNotAllowed", inputs: [{ name: "source", type: "address" }] },
  { type: "error", name: "InvalidThreshold", inputs: [] },
  { type: "error", name: "TriggerNotMet", inputs: [{ name: "priceX96", type: "uint256" }, { name: "boundX96", type: "uint256" }] },
  { type: "error", name: "TokenNotAllowed", inputs: [{ name: "token", type: "address" }] },
  { type: "error", name: "AdapterNotAllowed", inputs: [{ name: "adapter", type: "address" }] },
  { type: "error", name: "ZeroBalanceRelativeStep", inputs: [{ name: "index", type: "uint256" }] },
  { type: "error", name: "InvalidAdapterResult", inputs: [{ name: "index", type: "uint256" }, { name: "tokenOut", type: "address" }, { name: "amountOut", type: "uint256" }] },
  { type: "error", name: "Reentrancy", inputs: [] },
];

export const openZapV3Abi = [
  ...openZapV3Errors,
  {
    type: "function",
    name: "executeRecurring",
    stateMutability: "nonpayable",
    inputs: [
      { name: "intent", type: "tuple", components: recurringIntentComponents },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeTrigger",
    stateMutability: "nonpayable",
    inputs: [
      { name: "intent", type: "tuple", components: triggerIntentComponents },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "series",
    stateMutability: "view",
    inputs: [{ name: "seriesId", type: "uint256" }],
    outputs: [
      { name: "runs", type: "uint32" },
      { name: "lastRun", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "nonceUsed",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "policyHash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
];

export const priceSourceAbi = [
  {
    type: "function",
    name: "priceX96",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
];

export const lotteryPotAbi = [
  {
    type: "function",
    name: "buyZaps",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assetIn", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minZapsOut", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentRound",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "roundPrize",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];
