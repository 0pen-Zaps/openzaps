"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseSignature,
  parseUnits,
  type Abi,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";

import { CopyButton } from "@/components/CopyButton";
import { Glyph } from "@/components/Glyph";
import { RollingDigits } from "@/components/RollingDigits";
import { useCampaignCountdown } from "@/components/useCampaignCountdown";
import { useReducedMotionPreference } from "@/components/useReducedMotionPreference";
import { useWalletSession } from "@/components/WalletProvider";
import {
  FEE_REWARDS_MANIFEST,
  feeRewardsCampaignAbi,
  feeRewardsVaultAbi,
  campaignPhaseNote,
  formatCampaignPhase,
  formatCountdown,
  permitTokenAbi,
  projectedPrincipalShare,
  type FeeRewardsPayload,
} from "@/lib/rewards";
import { shareOfTotal, type FeeRewardsStakersPayload } from "@/lib/rewards-stakers";
import {
  HOOK_FEE_LABEL,
  campaignSwapShareLabel,
  ensureRobinhoodChain,
  explorerAddress,
  explorerTransaction,
  getInjectedProvider,
  robinhoodChain,
} from "@/lib/robinhood";
import styles from "./rewards.module.css";

export type RewardsWorkspaceName = "earn" | "stakers" | "operate" | "proof";

type SnapshotState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; data: FeeRewardsPayload; staleSince: string | null };

type ActionStage =
  | "idle"
  | "preparing"
  | "wallet"
  | "submitted"
  | "confirmed"
  | "verified"
  | "reverted"
  | "not-submitted"
  | "unknown";

type ActionEvidence = {
  stage: ActionStage;
  label: string;
  hash: Hash | null;
  message: string;
};

type WalletClients = {
  publicClient: PublicClient;
  walletClient: ReturnType<typeof createWalletClient>;
};

type ContractAction = {
  label: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  verifiedMessage: string;
  postcondition?: (client: PublicClient, blockNumber: bigint) => Promise<boolean>;
};

const EMPTY_ACTION: ActionEvidence = {
  stage: "idle",
  label: "",
  hash: null,
  message: "",
};

const WORKSPACES: readonly { id: RewardsWorkspaceName; label: string; hint: string }[] = [
  { id: "earn", label: "Stake & claim", hint: "Your position" },
  { id: "stakers", label: "Stakers", hint: "Verified positions" },
  { id: "operate", label: "Operate", hint: "Permissionless upkeep" },
  { id: "proof", label: "Proof", hint: "Contracts & terms" },
];

const STAKE_DECIMALS = 18;

/** Pool fee x the campaign's share of the fee vault. See campaignSwapShareLabel. */
const CAMPAIGN_SWAP_SHARE_LABEL = campaignSwapShareLabel(
  FEE_REWARDS_MANIFEST.campaign.feeShareAllocation,
  FEE_REWARDS_MANIFEST.vault.totalShares,
);
const POST_RECEIPT_REFRESH_ATTEMPTS = 8;
const POST_RECEIPT_REFRESH_DELAY_MS = 2_000;
const SNAPSHOT_REFRESH_RETRY_ATTEMPTS = 2;
const SNAPSHOT_REFRESH_RETRY_DELAY_MS = 1_000;

export type RewardsClaimLifecycle = "open" | "expired" | "swept";

export function rewardsClaimLifecycle(
  blockTimestamp: bigint,
  rewardsSwept: boolean,
): RewardsClaimLifecycle {
  if (rewardsSwept) return "swept";
  return blockTimestamp <= FEE_REWARDS_MANIFEST.campaign.claimDeadline ? "open" : "expired";
}

export function rewardsBalanceLabel(lifecycle: RewardsClaimLifecycle): string {
  if (lifecycle === "open") return "Claimable now";
  if (lifecycle === "swept") return "Accrued — rewards swept";
  return "Accrued — claim expired";
}

export function sponsoredClaimReady(
  currentLifecycle: RewardsClaimLifecycle,
  previewLifecycle: RewardsClaimLifecycle,
  earned: bigint,
  beneficiaryMatches: boolean,
): boolean {
  return currentLifecycle === "open"
    && previewLifecycle === "open"
    && earned > 0n
    && beneficiaryMatches;
}

export function snapshotIncludesBlock(
  snapshot: FeeRewardsPayload,
  minimumBlock: bigint,
): boolean {
  return BigInt(snapshot.headBlock) >= minimumBlock;
}

function expectedRuntimeCodeHash(address: Address): Hash | null {
  const normalized = address.toLowerCase();
  if (normalized === FEE_REWARDS_MANIFEST.campaign.address.toLowerCase()) return FEE_REWARDS_MANIFEST.campaign.runtimeCodeHash;
  if (normalized === FEE_REWARDS_MANIFEST.vault.address.toLowerCase()) return FEE_REWARDS_MANIFEST.vault.runtimeCodeHash;
  if (normalized === FEE_REWARDS_MANIFEST.adapter.address.toLowerCase()) return FEE_REWARDS_MANIFEST.adapter.runtimeCodeHash;
  return null;
}

export function RewardsWorkspace({
  initial,
  initialWorkspace,
}: {
  initial: FeeRewardsPayload | null;
  initialWorkspace: RewardsWorkspaceName;
}): React.JSX.Element {
  const {
    account,
    status: walletStatus,
    providerAvailable,
    isRobinhoodChain,
    connect,
    switchToRobinhood,
  } = useWalletSession();
  const [workspace, setWorkspace] = useState<RewardsWorkspaceName>(initialWorkspace);
  const [state, setState] = useState<SnapshotState>(
    initial ? { status: "ready", data: initial, staleSince: null } : { status: "loading" },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [action, setAction] = useState<ActionEvidence>(EMPTY_ACTION);
  const [stakeAmount, setStakeAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [beneficiary, setBeneficiary] = useState("");
  const [beneficiarySnapshot, setBeneficiarySnapshot] = useState<FeeRewardsPayload | null>(null);
  const sequence = useRef(0);
  const beneficiarySequence = useRef(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabsRef = useRef<HTMLElement | null>(null);
  const reducedMotion = useReducedMotionPreference();
  const writesEnabled = state.status === "ready" && state.staleSince === null;

  const fetchSnapshot = useCallback(async (viewer: Address | null): Promise<FeeRewardsPayload> => {
    const query = viewer ? `?viewer=${encodeURIComponent(viewer)}` : "";
    let response = await fetch(`/api/protocol/rewards${query}`, { cache: "no-store" });
    for (
      let attempt = 0;
      response.status === 202 && attempt < SNAPSHOT_REFRESH_RETRY_ATTEMPTS;
      attempt += 1
    ) {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, SNAPSHOT_REFRESH_RETRY_DELAY_MS);
      });
      response = await fetch(`/api/protocol/rewards${query}`, { cache: "no-store" });
    }
    if (response.status !== 200) throw new Error("The verified Robinhood Chain snapshot is unavailable.");
    return (await response.json()) as FeeRewardsPayload;
  }, []);

  const load = useCallback(async (viewer: Address | null): Promise<FeeRewardsPayload | null> => {
    const mine = ++sequence.current;
    try {
      const data = await fetchSnapshot(viewer);
      if (mine !== sequence.current) return null;
      setState({ status: "ready", data, staleSince: null });
      return data;
    } catch {
      if (mine !== sequence.current) return null;
      setState((current) =>
        current.status === "ready"
          ? { ...current, staleSince: current.staleSince ?? new Date().toISOString() }
          : { status: "unavailable" },
      );
      return null;
    }
  }, [fetchSnapshot]);

  const refreshThroughBlock = useCallback(async (
    viewer: Address,
    minimumBlock: bigint,
  ): Promise<boolean> => {
    for (let attempt = 0; attempt < POST_RECEIPT_REFRESH_ATTEMPTS; attempt += 1) {
      const snapshot = await load(viewer);
      if (snapshot && snapshotIncludesBlock(snapshot, minimumBlock)) return true;
      if (attempt + 1 < POST_RECEIPT_REFRESH_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, POST_RECEIPT_REFRESH_DELAY_MS);
        });
      }
    }
    return false;
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load(account);
    });
    const timer = window.setInterval(() => void load(account), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [account, load]);

  const refreshAtBoundary = useCallback((): void => {
    void load(account);
  }, [account, load]);

  /**
   * The explainer's closing action. Switching the workspace alone is
   * invisible — the tabs sit below the fold — so this also brings them into
   * view. Smooth scrolling is a motion source, so calm mode jumps instead.
   */
  const startStaking = useCallback((): void => {
    setWorkspace("earn");
    const url = new URL(window.location.href);
    url.searchParams.delete("workspace");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    tabsRef.current?.scrollIntoView({
      block: "start",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [reducedMotion]);

  const chooseWorkspace = useCallback((next: RewardsWorkspaceName): void => {
    setWorkspace(next);
    const url = new URL(window.location.href);
    if (next === "earn") url.searchParams.delete("workspace");
    else url.searchParams.set("workspace", next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const moveWorkspaceFocus = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, current: number): void => {
    const last = WORKSPACES.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = current === last ? 0 : current + 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = current === 0 ? last : current - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    chooseWorkspace(WORKSPACES[next].id);
    tabRefs.current[next]?.focus();
  }, [chooseWorkspace]);

  const walletClients = useCallback(async (): Promise<WalletClients> => {
    if (!account) throw new Error("Connect a wallet before preparing this action.");
    const provider = getInjectedProvider();
    if (!provider) throw new Error("No injected wallet was found in this browser.");
    await ensureRobinhoodChain(provider);
    const [chainId, accounts] = await Promise.all([
      provider.request({ method: "eth_chainId" }),
      provider.request({ method: "eth_accounts" }),
    ]);
    const expectedChainId = `0x${FEE_REWARDS_MANIFEST.chainId.toString(16)}`;
    if (typeof chainId !== "string" || chainId.toLowerCase() !== expectedChainId) {
      throw new Error("The wallet did not confirm Robinhood Chain after the network request.");
    }
    const current = Array.isArray(accounts) && typeof accounts[0] === "string" && isAddress(accounts[0])
      ? getAddress(accounts[0])
      : null;
    if (!current || current.toLowerCase() !== account.toLowerCase()) {
      throw new Error("The active wallet changed. Review the connected account and try again.");
    }
    return {
      publicClient: createPublicClient({ chain: robinhoodChain, transport: custom(provider) }),
      walletClient: createWalletClient({ account, chain: robinhoodChain, transport: custom(provider) }),
    };
  }, [account]);

  const runContract = useCallback(async (request: ContractAction): Promise<boolean> => {
    let submittedHash: Hash | null = null;
    setBusy(request.label);
    setError("");
    setNotice("");
    setAction({ stage: "preparing", label: request.label, hash: null, message: "Checking the exact call against the connected wallet RPC." });
    try {
      if (!account) throw new Error("Connect a wallet before preparing this action.");
      if (!writesEnabled) throw new Error("A fresh verified campaign snapshot is required before any transaction can be prepared.");
      if (!(await load(account))) throw new Error("The campaign could not be reverified immediately before this transaction. Nothing was submitted.");
      const { publicClient, walletClient } = await walletClients();
      const simulation = await publicClient.simulateContract({
        account,
        address: request.address,
        abi: request.abi,
        functionName: request.functionName,
        args: request.args ?? [],
      } as never);

      setAction({ stage: "wallet", label: request.label, hash: null, message: "Review the exact target and calldata in your wallet. Nothing has been submitted yet." });
      submittedHash = await walletClient.writeContract(simulation.request as never);
      setAction({ stage: "submitted", label: request.label, hash: submittedHash, message: "Submitted. Waiting for a Robinhood Chain receipt." });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: submittedHash });
      if (receipt.status !== "success") {
        setAction({ stage: "reverted", label: request.label, hash: submittedHash, message: "The receipt is final and reverted. No expected state change was applied." });
        setError("The transaction reverted onchain.");
        return false;
      }

      setAction({ stage: "confirmed", label: request.label, hash: submittedHash, message: "Receipt confirmed. Reading the expected postcondition at the receipt block." });
      const code = await publicClient.getBytecode({ address: request.address, blockNumber: receipt.blockNumber });
      if (!code || code === "0x") throw new Error("The receipt confirmed, but the target contract code could not be verified at that block.");
      const expectedCodeHash = expectedRuntimeCodeHash(request.address);
      if (expectedCodeHash && keccak256(code).toLowerCase() !== expectedCodeHash.toLowerCase()) {
        throw new Error("The receipt confirmed, but the target runtime hash no longer matches this release manifest.");
      }
      if (request.postcondition && !(await request.postcondition(publicClient, receipt.blockNumber))) {
        setAction({ stage: "unknown", label: request.label, hash: submittedHash, message: "The receipt confirmed, but the expected state was not observed. Inspect the receipt before retrying." });
        setError("Receipt confirmed without the expected postcondition readback.");
        return false;
      }

      const caughtUp = await refreshThroughBlock(account, receipt.blockNumber);
      if (!caughtUp) {
        const catchingUp = `${request.verifiedMessage} The shared position snapshot has not reached the receipt block yet, so further writes are paused while it catches up.`;
        setState((current) => current.status === "ready"
          ? { ...current, staleSince: current.staleSince ?? new Date().toISOString() }
          : current);
        setAction({ stage: "verified", label: request.label, hash: submittedHash, message: catchingUp });
        setNotice(catchingUp);
        // The submitted transaction succeeded, but false prevents a caller
        // such as approve→stake from chaining a second write against old state.
        return false;
      }
      setAction({ stage: "verified", label: request.label, hash: submittedHash, message: request.verifiedMessage });
      setNotice(request.verifiedMessage);
      return true;
    } catch (cause) {
      const message = readableError(cause);
      setAction({
        stage: submittedHash ? "unknown" : "not-submitted",
        label: request.label,
        hash: submittedHash,
        message: submittedHash
          ? "A hash exists, but final receipt verification was interrupted. Inspect it before retrying."
          : "Nothing was submitted.",
      });
      setError(message);
      return false;
    } finally {
      setBusy(null);
    }
  }, [account, load, refreshThroughBlock, walletClients, writesEnabled]);

  const failBeforeSubmission = useCallback((label: string, cause: unknown): void => {
    setAction({ stage: "not-submitted", label, hash: null, message: "Nothing was submitted." });
    setError(readableError(cause));
    setBusy(null);
  }, []);

  const data = state.status === "ready" ? state.data : null;
  const viewer = data?.viewer ?? null;
  const canStake = data?.phase === "upcoming" || data?.phase === "active";
  const claimLifecycle = data
    ? rewardsClaimLifecycle(BigInt(data.blockTimestamp), data.campaign.rewardsSwept)
    : "expired";

  const parsedStakeAmount = useMemo(() => parsePositiveAmount(stakeAmount), [stakeAmount]);
  const parsedWithdrawAmount = useMemo(() => parsePositiveAmount(withdrawAmount), [withdrawAmount]);

  const stakeWithPermit = useCallback(async (): Promise<void> => {
    if (!account || !viewer || !parsedStakeAmount) return;
    if (parsedStakeAmount > BigInt(viewer.tokenBalance)) {
      setError("The requested stake exceeds this wallet's verified 0xZAPS balance.");
      return;
    }
    setBusy("Permit + stake");
    setError("");
    setNotice("");
    try {
      const { publicClient, walletClient } = await walletClients();
      const [domain, nonce, stakedBefore, latestBlock] = await Promise.all([
        publicClient.readContract({ address: FEE_REWARDS_MANIFEST.token, abi: permitTokenAbi, functionName: "eip712Domain" }),
        publicClient.readContract({ address: FEE_REWARDS_MANIFEST.token, abi: permitTokenAbi, functionName: "nonces", args: [account] }),
        publicClient.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "balanceOf", args: [account] }),
        publicClient.getBlock({ blockTag: "latest" }),
      ]);
      const [fields, name, version, domainChainId, verifyingContract, salt, extensions] = domain;
      if (
        fields.toLowerCase() !== "0x0f"
        || name !== data?.permit.name
        || version !== data?.permit.version
        || domainChainId !== BigInt(FEE_REWARDS_MANIFEST.chainId)
        || verifyingContract.toLowerCase() !== FEE_REWARDS_MANIFEST.token.toLowerCase()
        || salt !== `0x${"0".repeat(64)}`
        || extensions.length !== 0
      ) {
        throw new Error("The token permit domain no longer matches the verified campaign manifest.");
      }
      const deadline = latestBlock.timestamp + 20n * 60n;
      setAction({ stage: "wallet", label: "Permit + stake", hash: null, message: "First wallet prompt: sign an exact, 20-minute 0xZAPS permit. This is not a transaction." });
      const signature = await walletClient.signTypedData({
        account,
        domain: { name, version, chainId: FEE_REWARDS_MANIFEST.chainId, verifyingContract: FEE_REWARDS_MANIFEST.token },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: {
          owner: account,
          spender: FEE_REWARDS_MANIFEST.campaign.address,
          value: parsedStakeAmount,
          nonce,
          deadline,
        },
      });
      const { v, r, s } = parseSignature(signature);
      await runContract({
        label: "Permit + stake",
        address: FEE_REWARDS_MANIFEST.campaign.address,
        abi: feeRewardsCampaignAbi,
        functionName: "stakeWithPermit",
        args: [parsedStakeAmount, deadline, Number(v), r, s],
        verifiedMessage: `Staked ${formatAmount(parsedStakeAmount.toString(), "0xZAPS")} and verified the credited balance at the receipt block.`,
        postcondition: async (client, blockNumber) => {
          const after = await client.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "balanceOf", args: [account], blockNumber });
          return after === stakedBefore + parsedStakeAmount;
        },
      });
    } catch (cause) {
      setAction({ stage: "not-submitted", label: "Permit + stake", hash: null, message: "Nothing was submitted." });
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [account, data, parsedStakeAmount, runContract, viewer, walletClients]);

  const approveAndStake = useCallback(async (): Promise<void> => {
    if (!account || !viewer || !parsedStakeAmount) return;
    if (parsedStakeAmount > BigInt(viewer.tokenBalance)) {
      setError("The requested stake exceeds this wallet's verified 0xZAPS balance.");
      return;
    }
    const allowance = BigInt(viewer.allowance);
    if (allowance < parsedStakeAmount) {
      const approved = await runContract({
        label: "Approve exact 0xZAPS",
        address: FEE_REWARDS_MANIFEST.token,
        abi: erc20Abi,
        functionName: "approve",
        args: [FEE_REWARDS_MANIFEST.campaign.address, parsedStakeAmount],
        verifiedMessage: "The exact requested 0xZAPS allowance was verified at the approval receipt block.",
        postcondition: async (client, blockNumber) => {
          const after = await client.readContract({ address: FEE_REWARDS_MANIFEST.token, abi: erc20Abi, functionName: "allowance", args: [account, FEE_REWARDS_MANIFEST.campaign.address], blockNumber });
          return after >= parsedStakeAmount;
        },
      });
      if (!approved) return;
    }
    try {
      const { publicClient } = await walletClients();
      const before = await publicClient.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "balanceOf", args: [account] });
      await runContract({
        label: "Stake approved 0xZAPS",
        address: FEE_REWARDS_MANIFEST.campaign.address,
        abi: feeRewardsCampaignAbi,
        functionName: "stake",
        args: [parsedStakeAmount],
        verifiedMessage: `Staked ${formatAmount(parsedStakeAmount.toString(), "0xZAPS")} and verified the credited balance at the receipt block.`,
        postcondition: async (client, blockNumber) => {
          const after = await client.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "balanceOf", args: [account], blockNumber });
          return after === before + parsedStakeAmount;
        },
      });
    } catch (cause) {
      failBeforeSubmission("Stake approved 0xZAPS", cause);
    }
  }, [account, failBeforeSubmission, parsedStakeAmount, runContract, viewer, walletClients]);

  const withdraw = useCallback(async (all: boolean): Promise<void> => {
    if (!account || !viewer) return;
    const label = all ? "Withdraw all principal" : "Withdraw principal";
    try {
      const { publicClient } = await walletClients();
      const current = await publicClient.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "balanceOf", args: [account] });
      const amount = all ? current : parsedWithdrawAmount;
      if (!amount || amount > current) {
        setError("Enter a withdrawal no greater than the current staked balance.");
        return;
      }
      await runContract({
        label,
        address: FEE_REWARDS_MANIFEST.campaign.address,
        abi: feeRewardsCampaignAbi,
        functionName: all ? "exit" : "withdraw",
        args: all ? [] : [amount],
        verifiedMessage: `Returned ${formatAmount(amount.toString(), "0xZAPS")} principal to the connected wallet and verified the campaign balance.`,
        postcondition: async (client, blockNumber) => {
          const after = await client.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "balanceOf", args: [account], blockNumber });
          return after + amount === current;
        },
      });
    } catch (cause) {
      failBeforeSubmission(label, cause);
    }
  }, [account, failBeforeSubmission, parsedWithdrawAmount, runContract, viewer, walletClients]);

  const claimSelf = useCallback(async (): Promise<void> => {
    if (!account || !viewer || !data) return;
    const currentLifecycle = rewardsClaimLifecycle(
      BigInt(data.blockTimestamp),
      data.campaign.rewardsSwept,
    );
    if (currentLifecycle !== "open") {
      setError(currentLifecycle === "swept"
        ? "Campaign rewards have been swept. No WETH claim can be submitted."
        : "The claim deadline has passed. Accrued WETH is no longer claimable.");
      return;
    }
    try {
      const { publicClient } = await walletClients();
      const [before, earnedBefore] = await Promise.all([
        publicClient.readContract({ address: FEE_REWARDS_MANIFEST.weth, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        publicClient.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "earned", args: [account, FEE_REWARDS_MANIFEST.weth] }),
      ]);
      if (earnedBefore === 0n) {
        setError("No WETH is claimable at the current wallet RPC block.");
        return;
      }
      await runContract({
        label: "Claim WETH rewards",
        address: FEE_REWARDS_MANIFEST.campaign.address,
        abi: feeRewardsCampaignAbi,
        functionName: "claimFor",
        args: [account],
        verifiedMessage: "WETH was paid directly to the connected beneficiary and its balance increase was verified at the receipt block.",
        postcondition: async (client, blockNumber) => {
          const after = await client.readContract({ address: FEE_REWARDS_MANIFEST.weth, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber });
          return after >= before + earnedBefore;
        },
      });
    } catch (cause) {
      failBeforeSubmission("Claim WETH rewards", cause);
    }
  }, [account, data, failBeforeSubmission, runContract, viewer, walletClients]);

  const operate = useCallback(async (kind: "harvest" | "sync" | "checkpoint" | "finalize" | "sweep"): Promise<void> => {
    const calls = {
      harvest: { fn: "harvest", label: "Harvest campaign fees", message: "The campaign pulled and synchronized available Clanker fees; the successful receipt and target code were verified." },
      sync: { fn: "syncRewards", label: "Sync received rewards", message: "Reward tokens already received by the campaign were synchronized under the fixed end time." },
      checkpoint: { fn: "checkpoint", label: "Checkpoint reward index", message: "The campaign's time-based reward index checkpoint was confirmed." },
      finalize: { fn: "finalize", label: "Finalize campaign", message: "Final settlement was confirmed and the 50 fee-share principal returned to the sponsor." },
      sweep: { fn: "sweepExpiredRewards", label: "Sweep expired rewards", message: "Expired unclaimed rewards were returned to the fixed sponsor after the claim deadline." },
    } as const;
    const call = calls[kind];
    await runContract({
      label: call.label,
      address: FEE_REWARDS_MANIFEST.campaign.address,
      abi: feeRewardsCampaignAbi,
      functionName: call.fn,
      verifiedMessage: call.message,
      postcondition: kind === "finalize"
        ? async (client, blockNumber) => {
            const [finalized, principal] = await Promise.all([
              client.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "finalized", blockNumber }),
              client.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "feeSharePrincipal", blockNumber }),
            ]);
            return finalized && principal === 0n;
          }
        : kind === "sweep"
          ? async (client, blockNumber) => client.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "rewardsSwept", blockNumber })
          : undefined,
    });
  }, [runContract]);

  const claimRetained = useCallback(async (checkpointedOnly: boolean): Promise<void> => {
    const sponsor = FEE_REWARDS_MANIFEST.campaign.sponsor;
    const label = checkpointedOnly ? "Claim checkpointed retained fees" : "Harvest retained-share fees";
    try {
      const { publicClient } = await walletClients();
      const [before, claimableBefore] = await Promise.all([
        publicClient.readContract({ address: FEE_REWARDS_MANIFEST.weth, abi: erc20Abi, functionName: "balanceOf", args: [sponsor] }),
        publicClient.readContract({ address: FEE_REWARDS_MANIFEST.vault.address, abi: feeRewardsVaultAbi, functionName: "claimable", args: [sponsor, FEE_REWARDS_MANIFEST.weth] }),
      ]);
      await runContract({
        label,
        address: FEE_REWARDS_MANIFEST.vault.address,
        abi: feeRewardsVaultAbi,
        functionName: checkpointedOnly ? "claimCheckpointedFor" : "claimFor",
        args: [sponsor],
        verifiedMessage: "Any paid WETH went directly to the fixed sponsor; the successful fixed-target receipt and available payout balance were verified.",
        postcondition: async (client, blockNumber) => {
          const after = await client.readContract({ address: FEE_REWARDS_MANIFEST.weth, abi: erc20Abi, functionName: "balanceOf", args: [sponsor], blockNumber });
          return claimableBefore === 0n ? after >= before : after >= before + claimableBefore;
        },
      });
    } catch (cause) {
      failBeforeSubmission(label, cause);
    }
  }, [failBeforeSubmission, runContract, walletClients]);

  const previewBeneficiary = useCallback(async (): Promise<void> => {
    const mine = ++beneficiarySequence.current;
    setError("");
    setBeneficiarySnapshot(null);
    if (!isAddress(beneficiary)) {
      setError("Enter one valid beneficiary address.");
      return;
    }
    setBusy("Preview beneficiary");
    try {
      const target = getAddress(beneficiary);
      const snapshot = await fetchSnapshot(target);
      if (mine !== beneficiarySequence.current || snapshot.viewer?.account.toLowerCase() !== target.toLowerCase()) return;
      setBeneficiarySnapshot(snapshot);
    } catch (cause) {
      if (mine === beneficiarySequence.current) setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [beneficiary, fetchSnapshot]);

  const claimBeneficiary = useCallback(async (): Promise<void> => {
    const preview = beneficiarySnapshot?.viewer;
    if (!preview || !beneficiarySnapshot || !data) return;
    if (!isAddress(beneficiary) || getAddress(beneficiary).toLowerCase() !== preview.account.toLowerCase()) {
      setBeneficiarySnapshot(null);
      setError("The beneficiary changed after preview. Verify the current address again before claiming.");
      return;
    }
    const currentLifecycle = rewardsClaimLifecycle(
      BigInt(data.blockTimestamp),
      data.campaign.rewardsSwept,
    );
    const previewLifecycle = rewardsClaimLifecycle(
      BigInt(beneficiarySnapshot.blockTimestamp),
      beneficiarySnapshot.campaign.rewardsSwept,
    );
    if (currentLifecycle !== "open" || previewLifecycle !== "open") {
      setError(currentLifecycle === "swept" || previewLifecycle === "swept"
        ? "Campaign rewards have been swept. No sponsored claim can be submitted."
        : "The claim deadline has passed. No sponsored claim can be submitted.");
      return;
    }
    const target = preview.account;
    try {
      const { publicClient } = await walletClients();
      const [before, earnedBefore] = await Promise.all([
        publicClient.readContract({ address: FEE_REWARDS_MANIFEST.weth, abi: erc20Abi, functionName: "balanceOf", args: [target] }),
        publicClient.readContract({ address: FEE_REWARDS_MANIFEST.campaign.address, abi: feeRewardsCampaignAbi, functionName: "earned", args: [target, FEE_REWARDS_MANIFEST.weth] }),
      ]);
      if (earnedBefore === 0n) {
        setError("The beneficiary has no WETH claimable at the current wallet RPC block.");
        return;
      }
      const paid = await runContract({
        label: "Claim for beneficiary",
        address: FEE_REWARDS_MANIFEST.campaign.address,
        abi: feeRewardsCampaignAbi,
        functionName: "claimFor",
        args: [target],
        verifiedMessage: "WETH was paid directly to the entered beneficiary; the caller could not redirect it.",
        postcondition: async (client, blockNumber) => {
          const after = await client.readContract({ address: FEE_REWARDS_MANIFEST.weth, abi: erc20Abi, functionName: "balanceOf", args: [target], blockNumber });
          return after >= before + earnedBefore;
        },
      });
      if (paid) {
        try {
          setBeneficiarySnapshot(await fetchSnapshot(target));
        } catch {
          setBeneficiarySnapshot(null);
        }
      }
    } catch (cause) {
      failBeforeSubmission("Claim for beneficiary", cause);
    }
  }, [beneficiary, beneficiarySnapshot, data, failBeforeSubmission, fetchSnapshot, runContract, walletClients]);

  const connectWallet = useCallback(async (): Promise<void> => {
    setBusy("Connect wallet");
    setError("");
    try {
      await connect();
      setNotice("Wallet connected on Robinhood Chain.");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [connect]);

  const switchNetwork = useCallback(async (): Promise<void> => {
    setBusy("Switch network");
    setError("");
    try {
      await switchToRobinhood();
      setNotice("Wallet switched to Robinhood Chain.");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }, [switchToRobinhood]);

  return (
    <>
      <div className={styles.heroGrid}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>TOKENIZED FEES · ROBINHOOD CHAIN</span>
          <h1 className={styles.title}>Stake 0xZAPS. Claim WETH from the pool&apos;s trading fees.</h1>
          <p className={styles.lede}>
            Every swap in the 0xZAPS ↔ aeWETH pool pays a {HOOK_FEE_LABEL} hook fee. This campaign was funded with
            50 of the 100 tokenized shares in that fee position and, across one seven-day window, splits the WETH
            it harvests among stakers by time-weighted stake. Holding 0xZAPS alone grants no fee rights — only a
            stake in this contract accrues a claim. Every figure on this page is read from chain 4663 at one
            verified block.
          </p>
        </div>

        <CampaignTerms data={data} onResync={refreshAtBoundary} />
      </div>

      <FeeMechanic data={data} onStart={startStaking} />

      <nav ref={tabsRef} className={styles.tabs} aria-label="Fee rewards workspace" role="tablist">
        {WORKSPACES.map((item, index) => (
          <button
            key={item.id}
            ref={(node) => { tabRefs.current[index] = node; }}
            id={`rewards-tab-${item.id}`}
            className={styles.tab}
            data-active={workspace === item.id || undefined}
            aria-controls={`rewards-panel-${item.id}`}
            aria-selected={workspace === item.id}
            onClick={() => chooseWorkspace(item.id)}
            onKeyDown={(event) => moveWorkspaceFocus(event, index)}
            role="tab"
            tabIndex={workspace === item.id ? 0 : -1}
            type="button"
          >
            <strong>{item.label}</strong>
            <span>{item.hint}</span>
          </button>
        ))}
      </nav>

      {state.status === "loading" ? <LoadingState /> : null}
      {state.status === "unavailable" ? <UnavailableState onRetry={() => void load(account)} /> : null}

      {data ? (
        <>
          {workspace === "earn" ? (
            <EarnWorkspace
              account={account}
              actionBusy={busy}
              canStake={canStake}
              claimLifecycle={claimLifecycle}
              data={data}
              isRobinhoodChain={isRobinhoodChain}
              parsedStakeAmount={parsedStakeAmount}
              parsedWithdrawAmount={parsedWithdrawAmount}
              providerAvailable={providerAvailable}
              stakeAmount={stakeAmount}
              walletStatus={walletStatus}
              withdrawAmount={withdrawAmount}
              writesEnabled={writesEnabled}
              onApproveAndStake={() => void approveAndStake()}
              onClaim={() => void claimSelf()}
              onConnect={() => void connectWallet()}
              onExit={() => void withdraw(true)}
              onSetStakeAmount={setStakeAmount}
              onSetWithdrawAmount={setWithdrawAmount}
              onStakeWithPermit={() => void stakeWithPermit()}
              onSwitch={() => void switchNetwork()}
              onWithdraw={() => void withdraw(false)}
            />
          ) : null}

          {workspace === "stakers" ? (
            <StakersWorkspace account={account} claimLifecycle={claimLifecycle} />
          ) : null}

          {workspace === "operate" ? (
            <OperateWorkspace
              beneficiary={beneficiary}
              beneficiarySnapshot={beneficiarySnapshot}
              busy={busy}
              data={data}
              connected={Boolean(account && isRobinhoodChain)}
              writesEnabled={writesEnabled}
              onBeneficiaryChange={(value) => {
                beneficiarySequence.current += 1;
                setBeneficiary(value);
                setBeneficiarySnapshot(null);
              }}
              onClaimBeneficiary={() => void claimBeneficiary()}
              onClaimRetained={(checkpointedOnly) => void claimRetained(checkpointedOnly)}
              onOperate={(kind) => void operate(kind)}
              onPreviewBeneficiary={() => void previewBeneficiary()}
            />
          ) : null}

          {workspace === "proof" ? <ProofWorkspace data={data} /> : null}

          <MessageStack notice={notice} error={error} staleSince={state.status === "ready" ? state.staleSince : null} />
          {action.stage !== "idle" ? <TransactionEvidence action={action} /> : null}
        </>
      ) : null}
    </>
  );
}

/**
 * The four-node diagram of the settlement path.
 *
 * It renders as a band inside the fee explainer rather than as its own panel:
 * a diagram and a five-step narration of the same pipeline, stacked as two
 * separate cards, read as the page saying everything twice.
 */
function SettlementRail({ data }: { data: FeeRewardsPayload | null }): React.JSX.Element {
  const verified = Boolean(data?.verification.sourcePositionConfigured && data.verification.vaultActivated);
  // The campaign node reports what it still holds: settlement returns the fee
  // shares to the sponsor, after which "50 shares" would be a stale claim.
  const holdsShares = data === null || BigInt(data.campaign.feeSharePrincipal) > 0n;
  const steps = [
    { icon: "swap", label: "0xZAPS trades", detail: "Clanker v4" },
    { icon: "vault", label: "Fee vault", detail: "100 ERC-20 shares" },
    { icon: "harvest", label: "Campaign", detail: holdsShares ? "50 shares" : "settled" },
    { icon: "coins", label: "WETH claims", detail: "Proportional" },
  ] as const;
  return (
    <div className={styles.settlement} aria-label="Fee settlement path">
      <ol className={styles.settlementSteps} data-flow={verified || undefined}>
        {steps.map((step, index) => (
          <li key={step.label}>
            <span className={styles.stepMark}><Glyph name={step.icon} /></span>
            <span className={styles.stepCopy}><strong>{step.label}</strong><em>{step.detail}</em></span>
            {index < steps.length - 1 ? <Glyph name="arrowRight" className={styles.stepArrow} /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

const COUNTDOWN_BOUNDARY_POLL_MS = 10_000;

/**
 * Live time-to-boundary readout for the current phase. The anchored estimate
 * lives in useCampaignCountdown; this row only renders it. The phase label
 * never flips from the local clock: once the boundary passes, the row reads
 * "awaiting the next verified block" while the hook nudges a snapshot refetch
 * until verified state moves.
 */
function CampaignCountdown({
  data,
  onResync,
}: {
  data: FeeRewardsPayload;
  onResync: () => void;
}): React.JSX.Element | null {
  const { countdown, remaining, reached, reduced } = useCampaignCountdown(
    data,
    onResync,
    COUNTDOWN_BOUNDARY_POLL_MS,
  );

  if (!countdown) return null;
  return (
    <p className={styles.countdown} role="timer" data-reached={reached || undefined}>
      <span>{reached ? countdown.reachedLabel : countdown.label}</span>
      <strong>
        {reached
          ? "awaiting the next verified block"
          : <RollingDigits animate={!reduced} value={formatCountdown(remaining, reduced ? "minute" : "second")} />}
      </strong>
    </p>
  );
}

function timelineFraction(now: bigint, from: bigint, to: bigint): number {
  if (now <= from) return 0;
  if (now >= to) return 1;
  return Number(now - from) / Number(to - from);
}

function timelineDay(timestamp: bigint): string {
  return new Date(Number(timestamp) * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Verified position along the campaign's fixed timeline. Both segments are
 * time-linear within themselves (the seven-day window and the 30-day claim
 * tail get fixed visual shares so the window stays readable), and the fill
 * derives from the same verified-block estimate as the countdown — never the
 * wall clock alone. Decorative duplicate of the dated terms above, so it is
 * hidden from assistive tech.
 */
function CampaignTimeline({ estimatedNow }: { estimatedNow: bigint }): React.JSX.Element {
  const { startAt, endAt, claimDeadline } = FEE_REWARDS_MANIFEST.campaign;
  const windowFill = timelineFraction(estimatedNow, startAt, endAt);
  const tailFill = timelineFraction(estimatedNow, endAt, claimDeadline);
  return (
    <div className={styles.timeline} aria-hidden="true">
      <div className={styles.timelineTrack}>
        <span className={styles.timelineWindow}>
          <i style={{ transform: `scaleX(${windowFill.toFixed(4)})` }} />
        </span>
        <span className={styles.timelineTail}>
          <i style={{ transform: `scaleX(${tailFill.toFixed(4)})` }} />
        </span>
      </div>
      <div className={styles.timelineLabels}>
        <span>{timelineDay(startAt)}</span>
        <span>{timelineDay(endAt)}</span>
        <span>{timelineDay(claimDeadline)}</span>
      </div>
    </div>
  );
}

/**
 * How a swap becomes a claimable WETH balance, in five steps.
 *
 * Each step carries one figure that is either a manifest constant or a live
 * verified read — never a projection, and never a rate. The closing boundary
 * block is part of the explainer, not a footnote: the same panel that says
 * what a staker gets says what the campaign does not promise.
 */
function FeeMechanic({
  data,
  onStart,
}: {
  data: FeeRewardsPayload | null;
  onStart: () => void;
}): React.JSX.Element {
  const harvested = data ? formatAmount(data.campaign.accountedRewardBalance, "WETH", 8) : null;
  const verified = Boolean(data?.verification.sourcePositionConfigured && data.verification.vaultActivated);
  const steps: readonly {
    title: string;
    body: React.ReactNode;
    fact: React.ReactNode;
  }[] = [
    {
      title: "A trade pays the pool fee",
      body: "Every swap in the 0xZAPS ↔ aeWETH Uniswap v4 pool pays the Clanker hook fee. Trading is the only thing that creates this cash flow.",
      fact: <><b>{HOOK_FEE_LABEL}</b> hook fee, read live</>,
    },
    {
      title: "The fee position is tokenized",
      body: "OpenZaps' claim on that position's reward slot is held by a vault that minted a fixed supply of fee shares. No more can ever be minted.",
      fact: <><b>100</b> shares, fixed supply</>,
    },
    {
      title: "Half of it funds this campaign",
      body: "50 of those 100 shares were transferred into the campaign contract before launch. They stay there until settlement returns them to the sponsor.",
      // feeSharesFunded latches true forever; the live principal is what the
      // campaign actually still holds after settlement returns the shares.
      fact: data === null
        ? <><b>50</b> shares — funding unverified</>
        : BigInt(data.campaign.feeSharePrincipal) > 0n
          ? <><b>50</b> shares funded — verified</>
          : <><b>50</b> shares returned to sponsor</>,
    },
    {
      title: "Anyone can harvest",
      body: (
        <>
          Harvest and sync are permissionless: they pull accrued WETH through the vault into the
          campaign, or account for WETH it already holds, so no operator stands between the fees and
          the stakers.
          {" "}
          This UI never asks for or spends the sponsor&apos;s WETH.
        </>
      ),
      fact: data === null
        ? <>Permissionless upkeep</>
        : data.phase === "upcoming"
          // Harvest reverts with CampaignNotStarted until the window opens, so
          // a "0 WETH harvested" figure here states a shortfall against an
          // action the contract refuses.
          ? <>Harvest opens <b>{formatDate(FEE_REWARDS_MANIFEST.campaign.startAt)}</b></>
          : <><b>{harvested}</b> harvested so far</>,
    },
    {
      title: "Stakers split it, time-weighted",
      body: "Your share of campaign-accounted WETH follows your stake and how long you hold it through the fixed end. Claims pay out to your own wallet.",
      // Past the deadline this must not read as an open invitation.
      fact: data?.phase === "expired"
        ? <>Claims closed <b>{formatDate(FEE_REWARDS_MANIFEST.campaign.claimDeadline)}</b></>
        : <>Claim by <b>{formatDate(FEE_REWARDS_MANIFEST.campaign.claimDeadline)}</b></>,
    },
  ];

  // The closing cell must never advertise an action the campaign has already
  // closed: staking ends with the window, claiming ends at the deadline.
  const staking = data === null || data.phase === "upcoming" || data.phase === "active";
  const claiming = data !== null && data.phase !== "expired";
  const cta = staking
    ? {
      title: "Rewards follow time held",
      body: "Reward weight accrues for as long as a stake sits in the campaign, so the same principal earns more the earlier it is staked within the window.",
      label: "Stake & claim",
    }
    : claiming
      ? {
        title: "Claims are still open",
        body: "New stakes have closed, but earned WETH stays claimable and principal stays withdrawable until the deadline.",
        label: "Claim & withdraw",
      }
      : {
        title: "This campaign has settled",
        body: "The claim deadline has passed. Your position and the campaign's final state remain readable onchain.",
        label: "View your position",
      };

  return (
    <section className={styles.mechanic} aria-labelledby="rewards-mechanic-title">
      <div className={styles.mechanicHead}>
        <div className={styles.mechanicHeadRow}>
          <span className={styles.panelEyebrow}>HOW THE FEES REACH A STAKER</span>
          <strong className={styles.mechanicVerified} data-verified={verified || undefined}>
            {data ? (verified ? "verified" : "unavailable") : "reading"}
          </strong>
        </div>
        <h2 id="rewards-mechanic-title">A swap, a share, a claim.</h2>
        <p>
          Nothing here mints, inflates, or borrows. The reward asset is WETH that the pool&apos;s own
          traders already paid, routed through contracts whose runtime hashes this page verifies before
          it renders a single figure.
        </p>
      </div>

      <SettlementRail data={data} />

      <ol className={styles.mechanicSteps}>
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className={styles.mechanicIndex}>{String(index + 1).padStart(2, "0")}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            <span className={styles.mechanicFact}>{step.fact}</span>
          </li>
        ))}
        {/* Fills the grid's sixth cell, which would otherwise read as a
            missing step, and puts the next action where the explanation
            ends. */}
        <li className={styles.mechanicCta}>
          {/* Occupies the numeral slot so this cell's heading sits on the
              same baseline as the steps beside it. */}
          <span className={styles.mechanicIndex}>NEXT</span>
          <h3>{cta.title}</h3>
          <p>{cta.body}</p>
          <button className={styles.primaryCompact} onClick={onStart} type="button">
            <Glyph name="boltFill" />{cta.label}
          </button>
        </li>
      </ol>

      <div className={styles.mechanicBoundary}>
        <Glyph name="alert" />
        <div>
          <h3>What this campaign does not promise</h3>
          <ul>
            <li><strong>No yield or APR.</strong> The rate above is the share of each swap that reaches the campaign, not a return. What a staker earns depends on trading volume and their share of the stake.</li>
            <li><strong>Holding 0xZAPS earns nothing.</strong> A fee claim accrues only while tokens are staked in this contract.</li>
            <li><strong>Staking puts funds at risk</strong> and confirmed transactions are irreversible.</li>
            <li><strong>Unclaimed WETH expires.</strong> After the claim deadline the sponsor can sweep whatever is left unclaimed.</li>
          </ul>
        </div>
      </div>

      <nav className={styles.relatedLinks} aria-label="Related pages">
        <span className={styles.panelEyebrow}>Related</span>
        <Link href="/token">0xZAPS token &amp; contract</Link>
        <Link href="/feeshare">Fee-share wrappers</Link>
        <Link href="/pot">Automation fee pot</Link>
        <Link href="/explore">Explore live Zaps</Link>
      </nav>
    </section>
  );
}

function CampaignTerms({
  data,
  onResync,
}: {
  data: FeeRewardsPayload | null;
  onResync: () => void;
}): React.JSX.Element {
  return (
    <aside className={styles.terms} aria-label="Campaign terms">
      <div className={styles.termsHead}>
        <span>CAMPAIGN TERMS</span>
        <i data-live={data?.phase === "active" || undefined} />
      </div>
      <strong className={styles.phase}>{data ? formatCampaignPhase(data.phase) : "Reading chain…"}</strong>
      {data ? <p className={styles.phaseNote}>{campaignPhaseNote(data.phase)}</p> : null}
      {data ? <CampaignCountdown data={data} onResync={onResync} /> : null}
      {/* The timeline is the campaign's map, not a countdown accessory: the
          phases with no clock target (settlement, expired) are exactly when a
          reader most needs to see where the window sat. */}
      {data ? <CampaignTimeline estimatedNow={BigInt(data.blockTimestamp)} /> : null}
      <dl className={styles.termList}>
        <div><dt>Stake token</dt><dd>0xZAPS</dd></div>
        <div><dt>Reward asset</dt><dd>WETH</dd></div>
        <div><dt>Reward source</dt><dd>LP trading fees</dd></div>
        <div><dt>Reward rate</dt><dd>{CAMPAIGN_SWAP_SHARE_LABEL} of each swap</dd></div>
        <div><dt>Duration</dt><dd>7 days</dd></div>
        <div><dt>Starts</dt><dd>{formatDate(FEE_REWARDS_MANIFEST.campaign.startAt)}</dd></div>
        <div><dt>Ends</dt><dd>{formatDate(FEE_REWARDS_MANIFEST.campaign.endAt)}</dd></div>
        <div><dt>Claim by</dt><dd>{formatDate(FEE_REWARDS_MANIFEST.campaign.claimDeadline)}</dd></div>
      </dl>
      {data ? (
        <p className={styles.blockRead}>State verified at block {Number(data.headBlock).toLocaleString("en-US")}.</p>
      ) : null}
    </aside>
  );
}

/**
 * What a typed stake would be worth as a share of principal right now.
 *
 * Deliberately a statement about principal at the verified block, not a
 * reward forecast: rewards are time-weighted and the reward pool itself
 * depends on trading fees nobody can promise. The note under the figure
 * says both things so the number cannot be read as a yield.
 */
function StakeShareProjection({
  stake,
  totalStaked,
}: {
  stake: bigint | null;
  totalStaked: bigint;
}): React.JSX.Element | null {
  if (stake === null) return null;
  const share = projectedPrincipalShare(stake, totalStaked);
  if (share === null) return null;
  return (
    <p className={styles.shareProjection}>
      <span>Share of staked principal</span>
      <strong>{share < 0.01 ? "<0.01%" : `${share}%`}</strong>
      <em>
        At this block, against {formatAmount(totalStaked.toString(), "0xZAPS")} already staked.
        Rewards are time-weighted, so the final split also depends on when you stake and how long
        you hold — and on the WETH the campaign actually harvests.
      </em>
    </p>
  );
}

type EarnProps = {
  account: Address | null;
  actionBusy: string | null;
  canStake: boolean;
  claimLifecycle: RewardsClaimLifecycle;
  data: FeeRewardsPayload;
  isRobinhoodChain: boolean;
  parsedStakeAmount: bigint | null;
  parsedWithdrawAmount: bigint | null;
  providerAvailable: boolean;
  stakeAmount: string;
  walletStatus: string;
  withdrawAmount: string;
  writesEnabled: boolean;
  onApproveAndStake: () => void;
  onClaim: () => void;
  onConnect: () => void;
  onExit: () => void;
  onSetStakeAmount: (value: string) => void;
  onSetWithdrawAmount: (value: string) => void;
  onStakeWithPermit: () => void;
  onSwitch: () => void;
  onWithdraw: () => void;
};

function EarnWorkspace(props: EarnProps): React.JSX.Element {
  const viewer = props.data.viewer;
  const connected = Boolean(
    props.account
    && props.isRobinhoodChain
    && viewer
    && viewer.account.toLowerCase() === props.account.toLowerCase(),
  );
  const stakeBalance = viewer ? BigInt(viewer.tokenBalance) : 0n;
  const staked = viewer ? BigInt(viewer.stakedBalance) : 0n;
  const earned = viewer ? BigInt(viewer.earnedWeth) : 0n;
  const claimsOpen = props.claimLifecycle === "open";
  const claimNote = props.claimLifecycle === "swept"
    ? "Expired campaign rewards have been swept to the fixed sponsor. This accrued figure is not claimable."
    : props.claimLifecycle === "expired"
      ? "The claim deadline has passed. This accrued figure is no longer claimable and may be swept to the fixed sponsor."
      : earned === 0n
        ? "No WETH is currently claimable at the verified block."
        : "The caller cannot change the payout address; WETH goes to your connected account.";
  return (
    <section id="rewards-panel-earn" aria-labelledby="rewards-tab-earn" className={styles.workspace} role="tabpanel">
      <div className={styles.walletBar}>
        <div>
          <span className={styles.panelEyebrow}>YOUR POSITION</span>
          <strong>{props.account ? short(props.account) : "Wallet not connected"}</strong>
          <p>{props.account ? "Balances are pinned to the same verified block as the campaign." : "Public campaign state stays visible without a wallet."}</p>
        </div>
        {!props.account ? (
          <button className={styles.secondaryButton} disabled={props.actionBusy !== null || props.walletStatus === "checking" || !props.providerAvailable} onClick={props.onConnect} type="button">
            {props.actionBusy === "Connect wallet" ? "Connecting…" : "Connect wallet"}
          </button>
        ) : !props.isRobinhoodChain ? (
          <button className={styles.secondaryButton} disabled={props.actionBusy !== null} onClick={props.onSwitch} type="button">
            {props.actionBusy === "Switch network" ? "Switching…" : "Switch to chain 4663"}
          </button>
        ) : null}
      </div>

      <dl className={styles.positionGrid}>
        <div><dt>Available</dt><dd>{viewer ? formatAmount(viewer.tokenBalance, "0xZAPS") : "—"}</dd></div>
        <div><dt>Staked principal</dt><dd>{viewer ? formatAmount(viewer.stakedBalance, "0xZAPS") : "—"}</dd></div>
        {/* The reward tint marks a figure worth acting on. Without a wallet
            there is no figure, so the emphasis would land on an em dash. */}
        <div className={connected ? styles.rewardStat : undefined}><dt>{rewardsBalanceLabel(props.claimLifecycle)}</dt><dd>{viewer ? formatAmount(viewer.earnedWeth, "WETH", 8) : "—"}</dd></div>
        {/* Whole tokens: four decimals on a seven-figure balance is precision
            nobody can act on, and it overflowed the cell. */}
        <div><dt>Campaign total</dt><dd>{formatAmount(props.data.campaign.totalStaked, "0xZAPS", 0)}</dd></div>
      </dl>

      <aside id="rewards-transaction-risk" className={styles.riskDisclosure} aria-label="Transaction risk">
        <Glyph name="alert" />
        <p><strong>Staking and other transactions put funds at risk and are irreversible once confirmed.</strong> Withdrawals are governed by contract state. Unclaimed rewards expire at the claim deadline.</p>
      </aside>

      <div className={styles.actionGrid} aria-describedby="rewards-transaction-risk">
        <article className={styles.actionCard}>
          <header><span className={styles.cardIcon}><Glyph name="lock" /></span><div><h2>Stake 0xZAPS</h2><p>Deposited principal remains governed by the campaign contract and its withdrawal functions. Rewards use time-weighted stake through the fixed end.</p></div></header>
          {props.data.phase === "upcoming" ? <p className={styles.openNote}>Pre-staking is open. Reward accounting begins at the fixed campaign start, not when tokens are deposited.</p> : null}
          <label className={styles.amountField}>
            <span>Amount</span>
            <div><input inputMode="decimal" placeholder="0.0" value={props.stakeAmount} onChange={(event) => props.onSetStakeAmount(event.target.value)} /><button type="button" onClick={() => props.onSetStakeAmount(formatUnits(stakeBalance, STAKE_DECIMALS))}>MAX</button><em>0xZAPS</em></div>
          </label>
          <StakeShareProjection
            stake={props.parsedStakeAmount}
            totalStaked={BigInt(props.data.campaign.totalStaked)}
          />
          <button className={styles.primaryButton} disabled={!props.writesEnabled || !connected || !props.canStake || !props.parsedStakeAmount || props.parsedStakeAmount > stakeBalance || props.actionBusy !== null} onClick={props.onStakeWithPermit} type="button">
            <Glyph name="boltFill" />{props.actionBusy === "Permit + stake" ? "Preparing permit…" : "Sign permit, then stake"}
          </button>
          <p className={styles.actionNote}>Two wallet prompts, one onchain transaction: an exact 20-minute permit signature, then the stake. No standing unlimited approval.</p>
          <details className={styles.fallback}>
            <summary>Wallet does not support permit?</summary>
            <p>The fallback uses an existing sufficient allowance, or asks for one exact approval transaction, followed by the stake transaction.</p>
            <button className={styles.secondaryButton} disabled={!props.writesEnabled || !connected || !props.canStake || !props.parsedStakeAmount || props.parsedStakeAmount > stakeBalance || props.actionBusy !== null} onClick={props.onApproveAndStake} type="button">Approve exact amount + stake</button>
          </details>
          {!props.canStake ? <p className={styles.closedNote}>New stakes are closed for this campaign. Withdrawals and eligible claims remain separate.</p> : null}
        </article>

        <article className={styles.actionCard}>
          <header><span className={styles.cardIcon}><Glyph name="coins" /></span><div><h2>Claim or withdraw</h2><p>Claims pay WETH to the beneficiary. Withdrawals return only your 0xZAPS principal.</p></div></header>
          <button className={styles.primaryButton} disabled={!props.writesEnabled || !connected || !claimsOpen || earned === 0n || props.actionBusy !== null} onClick={props.onClaim} type="button"><Glyph name="download" />{props.actionBusy === "Claim WETH rewards" ? "Claiming…" : "Claim WETH"}</button>
          <p className={styles.actionNote}>{claimNote}</p>
          <label className={styles.amountField}>
            <span>Principal to withdraw</span>
            <div><input inputMode="decimal" placeholder="0.0" value={props.withdrawAmount} onChange={(event) => props.onSetWithdrawAmount(event.target.value)} /><button type="button" onClick={() => props.onSetWithdrawAmount(formatUnits(staked, STAKE_DECIMALS))}>MAX</button><em>0xZAPS</em></div>
          </label>
          <div className={styles.buttonRow}>
            <button className={styles.secondaryButton} disabled={!props.writesEnabled || !connected || !props.parsedWithdrawAmount || props.parsedWithdrawAmount > staked || props.actionBusy !== null} onClick={props.onWithdraw} type="button">Withdraw amount</button>
            <button className={styles.textButton} disabled={!props.writesEnabled || !connected || staked === 0n || props.actionBusy !== null} onClick={props.onExit} type="button">Withdraw all</button>
          </div>
          <p className={styles.actionNote}>After the campaign ends, withdrawing principal preserves final reward weight until settlement. During the campaign, withdrawn tokens stop earning.</p>
        </article>
      </div>

      <div className={styles.boundary}><Glyph name="shield" /><p><strong>This UI never asks for wallet WETH.</strong> Stakers supply only 0xZAPS principal and gas. The configured harvest source is the tokenized Clanker fee position; the campaign contract can also account for WETH already sent directly to it.</p></div>
    </section>
  );
}

type StakersState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; list: FeeRewardsStakersPayload; staleSince: string | null };

const STAKERS_REFRESH_MS = 60_000;

/** Table amounts carry their unit in the column header, not per cell. */
function formatStakerAmount(value: string, maximumFractionDigits: number): string {
  const amount = Number(formatUnits(BigInt(value), 18));
  if (!Number.isFinite(amount)) return "—";
  return amount.toLocaleString("en-US", { maximumFractionDigits });
}

function formatShare(share: number | null): string {
  if (share === null) return "—";
  if (share > 0 && share < 0.01) return "<0.01%";
  return `${share.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/**
 * The verified staker register. Every row is an address enumerated from the
 * campaign's own Staked events and read back at one pinned block; the server
 * refuses to answer at all unless those balances sum exactly to the
 * campaign's totalStaked, so this table is complete or absent — a failed
 * read renders an explicit unavailable state, never a shorter list.
 */
function StakersWorkspace({
  account,
  claimLifecycle,
}: {
  account: Address | null;
  claimLifecycle: RewardsClaimLifecycle;
}): React.JSX.Element {
  const [state, setState] = useState<StakersState>({ status: "loading" });
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current;
    try {
      let response = await fetch("/api/protocol/rewards/stakers", { cache: "no-store" });
      for (
        let attempt = 0;
        response.status === 202 && attempt < SNAPSHOT_REFRESH_RETRY_ATTEMPTS;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, SNAPSHOT_REFRESH_RETRY_DELAY_MS);
        });
        response = await fetch("/api/protocol/rewards/stakers", { cache: "no-store" });
      }
      if (response.status !== 200) throw new Error("The verified staker list is unavailable.");
      const list = (await response.json()) as FeeRewardsStakersPayload;
      if (mine !== sequence.current) return;
      setState({ status: "ready", list, staleSince: null });
    } catch {
      if (mine !== sequence.current) return;
      setState((current) =>
        current.status === "ready"
          ? { ...current, staleSince: current.staleSince ?? new Date().toISOString() }
          : { status: "unavailable" },
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    const timer = window.setInterval(() => void load(), STAKERS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [load]);

  const list = state.status === "ready" ? state.list : null;
  const totalStaked = list ? BigInt(list.totalStaked) : 0n;
  const totalRewardWeight = list ? BigInt(list.totalRewardWeight) : 0n;

  return (
    <section id="rewards-panel-stakers" aria-labelledby="rewards-tab-stakers" className={styles.workspace} role="tabpanel">
      <header className={styles.workspaceHead}>
        <div>
          <span className={styles.panelEyebrow}>VERIFIED POSITIONS</span>
          <h2>Every staker, read at one block.</h2>
        </div>
        <p>
          Addresses are enumerated from the campaign&apos;s own Staked events and read back at a
          single verified block. The list is complete or absent: when its balances cannot be
          reconciled exactly against the campaign&apos;s total staked, nothing renders.
        </p>
      </header>

      {state.status === "loading" ? (
        <section className={styles.loading} aria-busy="true"><span /><span /><span /><p>Enumerating stakers at one Robinhood Chain block…</p></section>
      ) : null}

      {state.status === "unavailable" ? (
        <section className={styles.unavailable}>
          <Glyph name="alert" />
          <div>
            <h2>The staker list is unavailable.</h2>
            <p>The enumeration could not be verified as complete at one canonical block, so no partial or zeroed list is shown.</p>
            <button className={styles.secondaryButton} onClick={() => void load()} type="button">Retry verified read</button>
          </div>
        </section>
      ) : null}

      {list ? (
        <>
          <dl className={styles.positionGrid}>
            <div><dt>Staking now</dt><dd>{list.activeStakerCount.toLocaleString("en-US")} {list.activeStakerCount === 1 ? "address" : "addresses"}</dd></div>
            <div><dt>Total staked</dt><dd>{formatAmount(list.totalStaked, "0xZAPS", 0)}</dd></div>
            <div className={styles.rewardStat}><dt>Accrued, unclaimed</dt><dd>{formatAmount(list.totalEarnedWeth, "WETH", 8)}</dd></div>
            <div><dt>Claimed to date</dt><dd>{formatAmount(list.totalClaimedWeth, "WETH", 8)}</dd></div>
          </dl>

          {claimLifecycle !== "open" ? (
            <p className={styles.closedNote}>
              {claimLifecycle === "swept"
                ? "Expired campaign rewards have been swept to the fixed sponsor; accrued figures below are no longer claimable."
                : "The claim deadline has passed; accrued figures below are no longer claimable."}
            </p>
          ) : null}

          {list.stakers.length === 0 ? (
            <p className={styles.stakerEmpty}>
              No address holds a stake at the verified block. The register fills the moment the
              first stake lands onchain.
            </p>
          ) : (
            <div className={styles.stakerTableWrap} role="region" aria-label="Staker register" tabIndex={0}>
              <table className={styles.stakerTable}>
                <thead>
                  <tr>
                    <th scope="col" aria-label="Rank">#</th>
                    <th scope="col">Staker</th>
                    <th scope="col">Staked · 0xZAPS</th>
                    <th scope="col">Principal</th>
                    <th scope="col">Weight</th>
                    <th scope="col">Accrued · WETH</th>
                    <th scope="col">Claimed · WETH</th>
                  </tr>
                </thead>
                <tbody>
                  {list.stakers.map((row, index) => {
                    const isViewer = account !== null && row.account.toLowerCase() === account.toLowerCase();
                    const exited = BigInt(row.stakedBalance) === 0n;
                    return (
                      <tr key={row.account} data-you={isViewer || undefined}>
                        <td className={styles.stakerRank}>{index + 1}</td>
                        <th scope="row">
                          <span className={styles.stakerId}>
                            <code title={row.account}>{short(row.account)}</code>
                            {isViewer ? <em className={styles.youTag}>you</em> : null}
                            {exited ? <em className={styles.stakerTag}>exited</em> : null}
                            <a href={explorerAddress(row.account)} target="_blank" rel="noreferrer" aria-label={`Open ${short(row.account)} in explorer`}><Glyph name="external" /></a>
                          </span>
                        </th>
                        <td>{formatStakerAmount(row.stakedBalance, 2)}</td>
                        <td>{formatShare(shareOfTotal(BigInt(row.stakedBalance), totalStaked))}</td>
                        <td>{formatShare(shareOfTotal(BigInt(row.rewardWeight), totalRewardWeight))}</td>
                        <td>{formatStakerAmount(row.earnedWeth, 8)}</td>
                        <td>{formatStakerAmount(row.claimedWeth, 8)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className={styles.blockRead}>
                Staker register verified at block {Number(list.headBlock).toLocaleString("en-US")}
                {" · "}balances reconcile exactly with the campaign&apos;s total staked at that block.
              </p>
            </div>
          )}

          <p className={styles.stakerNote}>
            <strong>Weight</strong> is time-weighted stake — the share rewards actually split by,
            which grows the longer a stake sits through the window. <strong>Principal</strong> is
            the share of tokens staked at this block. Exited addresses keep whatever WETH they
            accrued while staked.
          </p>

          {list.truncated ? (
            <p className={styles.stakerNote}>
              Showing the {list.stakers.length.toLocaleString("en-US")} largest positions of{" "}
              {list.allTimeStakerCount.toLocaleString("en-US")} addresses that have ever staked.
              The totals above still cover every address.
            </p>
          ) : null}

          {state.status === "ready" && state.staleSince ? (
            <p className={styles.stakerStale}>
              <Glyph name="clock" />
              The staker register has not refreshed since{" "}
              {new Date(state.staleSince).toLocaleTimeString("en-US")}. Figures remain the last
              verified snapshot, not zeros.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

type OperateKind = "harvest" | "sync" | "checkpoint" | "finalize" | "sweep";

function OperateWorkspace({
  beneficiary,
  beneficiarySnapshot,
  busy,
  connected,
  data,
  writesEnabled,
  onBeneficiaryChange,
  onClaimBeneficiary,
  onClaimRetained,
  onOperate,
  onPreviewBeneficiary,
}: {
  beneficiary: string;
  beneficiarySnapshot: FeeRewardsPayload | null;
  busy: string | null;
  connected: boolean;
  data: FeeRewardsPayload;
  writesEnabled: boolean;
  onBeneficiaryChange: (value: string) => void;
  onClaimBeneficiary: () => void;
  onClaimRetained: (checkpointedOnly: boolean) => void;
  onOperate: (kind: OperateKind) => void;
  onPreviewBeneficiary: () => void;
}): React.JSX.Element {
  const timestamp = BigInt(data.blockTimestamp);
  const liveWindow = data.campaign.feeSharesFunded && !data.campaign.finalized && timestamp >= FEE_REWARDS_MANIFEST.campaign.startAt && timestamp <= FEE_REWARDS_MANIFEST.campaign.endAt;

  // A disabled control has to say why. The contract reverts these with
  // CampaignNotStarted before the window and refuses them after it closes,
  // so the sublabel names the boundary instead of describing an action the
  // reader cannot take.
  const upkeepClosedNote = timestamp < FEE_REWARDS_MANIFEST.campaign.startAt
    ? "Available at campaign start"
    : data.campaign.finalized
      ? "Campaign settled"
      : "Closed with the campaign window";  const canFinalize = data.campaign.feeSharesFunded && !data.campaign.finalized && timestamp > FEE_REWARDS_MANIFEST.campaign.endAt;
  const canSweep = data.campaign.finalized && !data.campaign.rewardsSwept && timestamp > FEE_REWARDS_MANIFEST.campaign.claimDeadline;
  const canCheckpoint = timestamp >= FEE_REWARDS_MANIFEST.campaign.startAt && !data.campaign.rewardsSwept;
  const currentClaimLifecycle = rewardsClaimLifecycle(timestamp, data.campaign.rewardsSwept);
  const beneficiaryEarned = beneficiarySnapshot?.viewer ? BigInt(beneficiarySnapshot.viewer.earnedWeth) : 0n;
  const beneficiaryClaimLifecycle = beneficiarySnapshot
    ? rewardsClaimLifecycle(
        BigInt(beneficiarySnapshot.blockTimestamp),
        beneficiarySnapshot.campaign.rewardsSwept,
      )
    : currentClaimLifecycle;
  const beneficiaryMatches = Boolean(
    beneficiarySnapshot?.viewer
    && isAddress(beneficiary)
    && getAddress(beneficiary).toLowerCase() === beneficiarySnapshot.viewer.account.toLowerCase(),
  );
  const canPayBeneficiary = sponsoredClaimReady(
    currentClaimLifecycle,
    beneficiaryClaimLifecycle,
    beneficiaryEarned,
    beneficiaryMatches,
  );
  const retainedClaimable = BigInt(data.vault.sponsorClaimableWeth);
  return (
    <section id="rewards-panel-operate" aria-labelledby="rewards-tab-operate" className={styles.workspace} role="tabpanel">
      <header className={styles.workspaceHead}><div><span className={styles.panelEyebrow}>CAMPAIGN OPERATIONS</span><h2>Public upkeep. Fixed destinations.</h2></div><p>These calls are permissionless. The contracts determine every source and payout; this UI exposes no generic sender or editable calldata.</p></header>
      <div className={styles.operatorGrid}>
        <article className={styles.operatorCard}>
          <header><Glyph name="harvest" /><div><h3>Live-window upkeep</h3><p>Bring new fees into the campaign and advance its accounting.</p></div></header>
          <div className={styles.operatorActions}>
            <button disabled={!writesEnabled || !connected || !liveWindow || busy !== null} onClick={() => onOperate("harvest")} type="button"><strong>Harvest fees</strong><span>{liveWindow ? "Pull vault WETH + sync" : upkeepClosedNote}</span><Glyph name="chevronRight" /></button>
            <button disabled={!writesEnabled || !connected || !liveWindow || busy !== null} onClick={() => onOperate("sync")} type="button"><strong>Sync rewards</strong><span>{liveWindow ? "Account for WETH already received" : upkeepClosedNote}</span><Glyph name="chevronRight" /></button>
            <button disabled={!writesEnabled || !connected || !canCheckpoint || busy !== null} onClick={() => onOperate("checkpoint")} type="button"><strong>Checkpoint index</strong><span>{canCheckpoint ? "No token transfer or upstream call" : "Available at campaign start"}</span><Glyph name="chevronRight" /></button>
          </div>
        </article>
        <article className={styles.operatorCard}>
          <header><Glyph name="clock" /><div><h3>Settlement</h3><p>Return fee-share principal, then close expired claims.</p></div></header>
          <div className={styles.operatorActions}>
            <button disabled={!writesEnabled || !connected || !canFinalize || busy !== null} onClick={() => onOperate("finalize")} type="button"><strong>Finalize campaign</strong><span>{data.campaign.finalized ? "Already finalized" : canFinalize ? "Final harvest + return 50 shares" : "Available after the end"}</span><Glyph name="chevronRight" /></button>
            <button disabled={!writesEnabled || !connected || !canSweep || busy !== null} onClick={() => onOperate("sweep")} type="button"><strong>Sweep expired WETH</strong><span>{data.campaign.rewardsSwept ? "Already swept" : "Only after the claim deadline"}</span><Glyph name="chevronRight" /></button>
          </div>
        </article>
        <article className={styles.operatorCard}>
          <header><Glyph name="vault" /><div><h3>Sponsor allocation</h3><p>50 fee shares were retained at launch; finalization returns the campaign&apos;s other 50.</p></div></header>
          <div className={styles.retainedValue}><span>Checkpointed claimable</span><strong>{formatAmount(data.vault.sponsorClaimableWeth, "WETH", 8)}</strong></div>
          <p className={styles.actionNote}>Current sponsor balance: {formatAmount(data.vault.sponsorFeeShareBalance, "fee shares", 4)}.</p>
          <div className={styles.buttonRow}>
            <button className={styles.secondaryButton} disabled={!writesEnabled || !connected || busy !== null} onClick={() => onClaimRetained(false)} type="button">Harvest + pay sponsor</button>
            <button className={styles.textButton} disabled={!writesEnabled || !connected || retainedClaimable === 0n || busy !== null} onClick={() => onClaimRetained(true)} type="button">Pay checkpointed only</button>
          </div>
          <p className={styles.actionNote}>Anyone may pay gas, but WETH can only go to {short(FEE_REWARDS_MANIFEST.campaign.sponsor)}.</p>
        </article>
        <article className={styles.operatorCard}>
          <header><Glyph name="hand" /><div><h3>Sponsor a user claim</h3><p>{currentClaimLifecycle === "open" ? "Remove claim friction without taking custody or changing the beneficiary." : "The claim window is closed. Preview remains available for proof, but no claim can be submitted."}</p></div></header>
          <label className={styles.beneficiaryField}><span>Beneficiary</span><input placeholder="0x…" value={beneficiary} onChange={(event) => onBeneficiaryChange(event.target.value)} /></label>
          <div className={styles.buttonRow}>
            <button className={styles.secondaryButton} disabled={busy !== null || !isAddress(beneficiary)} onClick={onPreviewBeneficiary} type="button">Preview claim</button>
            <button className={styles.primaryCompact} disabled={!writesEnabled || !connected || busy !== null || !canPayBeneficiary} onClick={onClaimBeneficiary} type="button">Pay beneficiary</button>
          </div>
          {currentClaimLifecycle !== "open" ? <p className={styles.closedNote}>{currentClaimLifecycle === "swept" ? "Expired rewards have already been swept; sponsored claims are permanently closed." : "The claim deadline has passed; accrued amounts are no longer claimable."}</p> : null}
          {beneficiarySnapshot?.viewer ? <p className={styles.beneficiaryRead}>Verified for {short(beneficiarySnapshot.viewer.account)}: <strong>{formatAmount(beneficiarySnapshot.viewer.earnedWeth, "WETH", 8)}</strong> {beneficiaryClaimLifecycle === "open" ? "claimable" : beneficiaryClaimLifecycle === "swept" ? "accrued before rewards were swept" : "accrued, but expired"} at block {Number(beneficiarySnapshot.headBlock).toLocaleString("en-US")}.</p> : null}
        </article>
      </div>
      {!connected ? <div className={styles.boundary}><Glyph name="wallet" /><p>Connect a wallet on chain 4663 to submit upkeep. Inspection remains public; connecting grants no operator role or withdrawal authority.</p></div> : null}
    </section>
  );
}

function ProofWorkspace({ data }: { data: FeeRewardsPayload }): React.JSX.Element {
  const contracts = [
    { label: "Fee-source adapter", value: FEE_REWARDS_MANIFEST.adapter.address, hash: data.verification.adapterCodeHash },
    { label: "Fee-share vault", value: FEE_REWARDS_MANIFEST.vault.address, hash: data.verification.vaultCodeHash },
    { label: "Staking campaign", value: FEE_REWARDS_MANIFEST.campaign.address, hash: data.verification.campaignCodeHash },
  ] as const;
  return (
    <section id="rewards-panel-proof" aria-labelledby="rewards-tab-proof" className={styles.workspace} role="tabpanel">
      <header className={styles.workspaceHead}><div><span className={styles.panelEyebrow}>RELEASE MANIFEST</span><h2>One adapter, one vault, one campaign.</h2></div><p>The UI renders live state only after runtime hashes, immutable bindings, reward assets, terms, and the canonical block hash match this reviewed release.</p></header>
      <div className={styles.proofGrid}>
        <section className={styles.proofCard}>
          <h3>Contract identity</h3>
          <div className={styles.contractList}>
            {contracts.map((contract) => (
              <div key={contract.label}>
                <span>{contract.label}</span>
                <p><code>{contract.value}</code><CopyButton value={contract.value} label="Copy" /><a href={explorerAddress(contract.value)} target="_blank" rel="noreferrer" aria-label={`Open ${contract.label} in explorer`}><Glyph name="external" /></a></p>
                <small>runtime <code>{contract.hash}</code></small>
              </div>
            ))}
          </div>
        </section>
        <section className={styles.proofCard}>
          <h3>Verified terms</h3>
          <dl className={styles.proofFacts}>
            <div><dt>Chain</dt><dd>Robinhood Chain · 4663</dd></div>
            <div><dt>Deployment block</dt><dd>{Number(FEE_REWARDS_MANIFEST.campaign.deploymentBlock).toLocaleString("en-US")}</dd></div>
            <div><dt>Fixed supply</dt><dd>100 fee-share ERC-20s</dd></div>
            <div><dt>Campaign allocation</dt><dd>50 fee shares</dd></div>
            <div><dt>Retained at launch</dt><dd>50 fee shares</dd></div>
            <div><dt>Stake token</dt><dd>0xZAPS</dd></div>
            <div><dt>Reward asset</dt><dd>WETH only</dd></div>
            <div><dt>Current source link</dt><dd>{data.verification.sourcePositionConfigured ? "Verified" : "Unavailable"}</dd></div>
          </dl>
        </section>
      </div>
      <div className={styles.proofNotes}>
        <article><Glyph name="coins" /><h3>ERC-20, not NFT</h3><p>Every fee share is economically identical and divisible. Fungible shares make the 50/50 allocation, campaign custody, and proportional accounting direct; an NFT would add position complexity without adding a distinct right.</p></article>
        <article><Glyph name="pool" /><h3>No custom hook required</h3><p>Clanker&apos;s existing v4 pool already generates the trading-fee cash flow. The reviewed adapter harvests that fixed position; this campaign does not modify swap execution or introduce a new hook.</p></article>
        <article><Glyph name="shield" /><h3>What is not here</h3><p>No APY projection, wallet-WETH funding flow in this interface, generic transaction sender, top-holder bonus, volume leaderboard, or redirectable sponsored claim. Those require separate deterministic rules before they can be represented.</p></article>
      </div>
      <p className={styles.proofFoot}>Canonical state read at block {Number(data.headBlock).toLocaleString("en-US")} · {new Date(data.readAt).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}. Historical fee attribution is not inferred from this current-state snapshot.</p>
    </section>
  );
}

function MessageStack({ notice, error, staleSince }: { notice: string; error: string; staleSince: string | null }): React.JSX.Element | null {
  if (!notice && !error && !staleSince) return null;
  return (
    <div className={styles.messages} aria-live="polite">
      {notice ? <p className={styles.success}><Glyph name="check" />{notice}</p> : null}
      {error ? <p className={styles.error} role="alert"><Glyph name="alert" />{error}</p> : null}
      {staleSince ? <p className={styles.stale}><Glyph name="clock" />Refresh has failed since {new Date(staleSince).toLocaleTimeString("en-US")}. Figures remain the last verified snapshot, not zeros; every transaction is paused until verification recovers.</p> : null}
    </div>
  );
}

function TransactionEvidence({ action }: { action: ActionEvidence }): React.JSX.Element {
  const stages: readonly { id: ActionStage; label: string }[] = [
    { id: "preparing", label: "Prepare" },
    { id: "wallet", label: "Wallet" },
    { id: "submitted", label: "Receipt" },
    { id: "verified", label: "Readback" },
  ];
  const order: ActionStage[] = ["idle", "preparing", "wallet", "submitted", "confirmed", "verified"];
  const current = order.indexOf(action.stage);
  const terminalError = action.stage === "reverted" || action.stage === "not-submitted" || action.stage === "unknown";
  return (
    <section className={styles.evidence} aria-label="Transaction evidence">
      <header><div><span>LAST WALLET ACTION</span><strong>{action.label}</strong></div><em data-stage={action.stage}>{stageLabel(action.stage)}</em></header>
      <ol>
        {stages.map((stage, index) => {
          const stageIndex = order.indexOf(stage.id);
          const done = !terminalError && current > stageIndex;
          const active = !terminalError && (action.stage === stage.id || (stage.id === "submitted" && action.stage === "confirmed"));
          return <li key={stage.id} data-done={done || undefined} data-active={active || undefined} data-error={terminalError && index === Math.max(0, Math.min(3, current)) || undefined}><i>{done ? "✓" : index + 1}</i><span>{stage.label}</span></li>;
        })}
      </ol>
      <p>{action.message}</p>
      {action.hash ? <a href={explorerTransaction(action.hash)} target="_blank" rel="noreferrer">View receipt {short(action.hash)} <Glyph name="external" /></a> : null}
    </section>
  );
}

function LoadingState(): React.JSX.Element {
  return <section className={styles.loading} aria-busy="true"><span /><span /><span /><p>Verifying the campaign at one Robinhood Chain block…</p></section>;
}

function UnavailableState({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return <section className={styles.unavailable}><Glyph name="alert" /><div><h2>Campaign reads are unavailable.</h2><p>No balances, rewards, or contract claims are shown because the full manifest could not be verified at one canonical block.</p><button className={styles.secondaryButton} onClick={onRetry} type="button">Retry verified read</button></div></section>;
}

function parsePositiveAmount(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,18})?$/.test(normalized)) return null;
  try {
    const amount = parseUnits(normalized, STAKE_DECIMALS);
    return amount > 0n ? amount : null;
  } catch {
    return null;
  }
}

function formatAmount(value: string, symbol: string, maximumFractionDigits = 4): string {
  const amount = Number(formatUnits(BigInt(value), 18));
  if (!Number.isFinite(amount)) return `— ${symbol}`;
  return `${amount.toLocaleString("en-US", { maximumFractionDigits })} ${symbol}`;
}

function formatDate(timestamp: bigint): string {
  return new Date(Number(timestamp) * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function short(value: string): string {
  return value.length <= 14 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function readableError(cause: unknown): string {
  if (!(cause instanceof Error)) return "The wallet action could not be prepared.";
  const first = cause.message.split("\n")[0]?.trim();
  if (!first) return "The wallet action could not be prepared.";
  return first.length > 220 ? `${first.slice(0, 217)}…` : first;
}

function stageLabel(stage: ActionStage): string {
  if (stage === "not-submitted") return "NOT SUBMITTED";
  if (stage === "submitted") return "SUBMITTED";
  if (stage === "confirmed") return "CONFIRMED";
  if (stage === "verified") return "VERIFIED";
  if (stage === "reverted") return "REVERTED";
  if (stage === "unknown") return "VERIFY MANUALLY";
  if (stage === "wallet") return "WALLET REVIEW";
  return "PREPARING";
}
