import { getAddress, parseAbi } from "viem";

/**
 * Immutable public manifest for the fee-share wrapper instruments
 * (FeeShareTermWrap + FeeShareAutoCompounder).
 *
 * The wrapper contracts are merged to `main` and hardened across internal
 * adversarial review, but they are NOT deployed. `termWrap` and
 * `autoCompounder` are therefore `null`: a deployment is a reviewed release and
 * must arrive here as an address plus a verified `runtimeCodeHash` in a source
 * change, exactly like the live fee campaign manifest. Until then the surface
 * fails closed — there is nothing to read and nothing to sign.
 *
 * The reference addresses below (the reward asset, 0xZAPS, and the live fee
 * vault whose shares these wrap) are already deployed and verifiable; they are
 * context, not the wrappers themselves.
 */
export const FEESHARE_WRAP_MANIFEST = {
  chainId: 4663,
  chainName: "Robinhood Chain",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  /** WETH — the reward asset the fee vault pays. */
  reward: {
    symbol: "WETH",
    address: getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  },
  /** 0xZAPS — the token the auto-compounder routes reward into. */
  zaps: {
    symbol: "0xZAPS",
    address: getAddress("0xDd90bFa4adC7F4401E611AbaC692D939F9F4CB07"),
  },
  /** The live tokenized fee-share vault whose shares these wrappers wrap. */
  feeShareVault: getAddress("0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338"),
  /**
   * Deployed wrapper terms land here as a reviewed release. Shape when set:
   * { address: Address; runtimeCodeHash: Hex; deploymentBlock: bigint;
   *   depositUntil: bigint; maturity: bigint; claimDeadline: bigint }.
   */
  termWrap: null,
  /**
   * Shape when set: { address: Address; runtimeCodeHash: Hex;
   *   deploymentBlock: bigint; adapter: Address; priceSource: Address;
   *   minOutBps: number; maxRouteWei: bigint; minRouteWei: bigint }.
   */
  autoCompounder: null,
} as const;

/**
 * Deployment state of the wrapper instruments, all-or-nothing like the v3.2
 * seven-address set: both wrappers deployed = `configured`; neither = `absent`
 * (the deliberate not-live state); one without the other = `partial`, a release
 * error the surface must never present as usable.
 */
export function feeShareWrapDeployment(): "absent" | "partial" | "configured" {
  const term = FEESHARE_WRAP_MANIFEST.termWrap !== null;
  const auto = FEESHARE_WRAP_MANIFEST.autoCompounder !== null;
  if (term && auto) return "configured";
  if (!term && !auto) return "absent";
  return "partial";
}

export const feeShareTermWrapAbi = parseAbi([
  "function FEE_SHARES() view returns (address)",
  "function REWARD() view returns (address)",
  "function DEPOSIT_UNTIL() view returns (uint64)",
  "function MATURITY() view returns (uint64)",
  "function CLAIM_DEADLINE() view returns (uint64)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  "function totalLocked() view returns (uint256)",
  "function depositedShares(address account) view returns (uint256)",
  "function redeemedShares(address account) view returns (uint256)",
  "function cumulativeRewardPerUnit() view returns (uint256)",
  "function rewardReserve() view returns (uint256)",
  "function cumulativePostPerLocked() view returns (uint256)",
  "function postReserve() view returns (uint256)",
  "function claimableReward(address account) view returns (uint256)",
  "function claimableLockedReward(address account) view returns (uint256)",
  "function deposit(uint256 shares)",
  "function harvest()",
  "function claim()",
  "function redeemShares()",
  "function claimLockedReward()",
  "function sweepExpired()",
  "event Deposited(address indexed account, uint256 shares)",
  "event Harvested(address indexed caller, uint256 rewardReceived)",
  "event RewardClaimed(address indexed account, uint256 amount)",
  "event SharesRedeemed(address indexed account, uint256 shares)",
  "event LockedRewardClaimed(address indexed account, uint256 amount)",
  "event ExpiredSwept(address indexed account, uint256 amount)",
]);

export const feeShareAutoCompounderAbi = parseAbi([
  "function FEE_SHARES() view returns (address)",
  "function WETH() view returns (address)",
  "function ZAPS() view returns (address)",
  "function ADAPTER() view returns (address)",
  "function PRICE_SOURCE() view returns (address)",
  "function MIN_OUT_BPS() view returns (uint16)",
  "function MAX_ROUTE_WEI() view returns (uint256)",
  "function MIN_ROUTE_WEI() view returns (uint256)",
  "function deposits(address account) view returns (uint256)",
  "function totalDeposits() view returns (uint256)",
  "function cumulativeWethPerShare() view returns (uint256)",
  "function wethReserve() view returns (uint256)",
  "function wethOwed(address account) view returns (uint256)",
  "function autoRouteAllowed(address account) view returns (bool)",
  "function claimableWeth(address account) view returns (uint256)",
  "function deposit(uint256 shares)",
  "function withdraw(uint256 shares)",
  "function claimWeth()",
  "function route()",
  "function routeFor(address account)",
  "function setAutoRoute(bool allowed)",
  "event Deposited(address indexed account, uint256 shares)",
  "event Withdrawn(address indexed account, uint256 shares)",
  "event WethClaimed(address indexed account, uint256 amount)",
  "event AutoRouteSet(address indexed account, bool allowed)",
  "event Routed(address indexed caller, address indexed account, uint256 wethIn, uint256 zapsOut, uint256 floor)",
]);

export type FeeShareInstrument = {
  id: "term-wrap" | "auto-compounder";
  name: string;
  contract: string;
  tagline: string;
  /** What holding / using the instrument does, in plain terms. */
  points: readonly string[];
  /** The bounded, immutable terms a reader should know before it goes live. */
  terms: readonly { label: string; value: string }[];
};

/**
 * Plain-language description of each instrument, driven from the merged
 * contracts. Every claim here is a mechanism the contract enforces, never a
 * return. Rendered on the surface and pinned by the page test.
 */
export const FEESHARE_INSTRUMENTS: readonly FeeShareInstrument[] = [
  {
    id: "term-wrap",
    name: "Term wrap",
    contract: "FeeShareTermWrap",
    tagline: "A term-bound coupon strip over tokenized fee shares.",
    points: [
      "Lock fee shares before the deposit window closes and mint transferable wrapped units 1:1.",
      "During the term the vault reward on the locked shares accrues to the wrapped units — the coupon — which anyone can harvest and holders claim until the deadline.",
      "After maturity the original depositor redeems exactly their principal, gated only on the clock so a paused vault can never trap it.",
      "Post-maturity reward is generated only by still-locked shares, so it is paid to currently-locked principal, never to a depositor who already redeemed.",
    ],
    terms: [
      { label: "Wrapped units", value: "1:1 with deposited fee shares, 18 decimals" },
      { label: "Bounds", value: "Immutable deposit window, maturity, and claim deadline" },
      { label: "Upkeep", value: "Permissionless harvest; no owner, pause, or upgrade" },
    ],
  },
  {
    id: "auto-compounder",
    name: "Auto-compounder",
    contract: "FeeShareAutoCompounder",
    tagline: "Turn the fee shares' WETH reward into 0xZAPS, per depositor.",
    points: [
      "Deposit fee shares and keep them withdrawable at any time; reward accrues to each depositor as WETH, per share.",
      "Route your own WETH into 0xZAPS through one constructor-pinned adapter, floored against a pinned price source — no path arrays, no arbitrary router.",
      "Keeper routing is opt-in only; claimWeth is a non-front-runnable escape hatch, so reward is always recoverable as WETH.",
      "A per-block route cap bounds any single sandwich to one depositor's WETH.",
    ],
    terms: [
      { label: "Route target", value: "One immutable adapter + price source" },
      { label: "Floor", value: "Immutable minimum-out basis points, same-block spot" },
      { label: "Keeper access", value: "Off by default; per-depositor opt-in" },
    ],
  },
];
