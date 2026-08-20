"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  keccak256,
  parseUnits,
  type Abi,
  type Address,
  type Hash,
} from "viem";

import { useWalletSession } from "@/components/WalletProvider";
import {
  campaignPhase,
  campaignPhaseNote,
  feeRewardsCampaignAbi,
  formatCampaignPhase,
  permitTokenAbi,
  type FeeRewardsPhase,
} from "@/lib/rewards";
import { FEE_REWARDS_2_MANIFEST, feeRewards2Deployment } from "@/lib/rewards2";
import type { Campaign2Preflight } from "@/lib/rewards2-server";
import {
  ensureRobinhoodChain,
  explorerTransaction,
  getInjectedProvider,
  robinhoodChain,
} from "@/lib/robinhood";
import styles from "./campaign2.module.css";

const REFRESH_MS = 60_000;

// Boundary copy as single-line constants, pinned verbatim by the page test.
const STAKE_RISK =
  "These contracts have not been externally audited. Transactions put funds at risk and are irreversible once confirmed.";
const STAKE_BOUNDARY =
  "Staking earns no yield by itself: rewards are whatever WETH the fee stream actually produces during the window, split by time-weighted stake, and may be zero.";
const PRESTAKE_NOTE =
  "Pre-staking is open. Reward weight starts accruing at the fixed start, not on deposit — staking earlier than the start does not earn more.";

type WriteStage =
  | "idle"
  | "preparing"
  | "wallet"
  | "submitted"
  | "reverted"
  | "verified"
  | "unknown"
  | "not-submitted";

type WriteState = { stage: WriteStage; label: string; hash: Hash | null; message: string };

type ViewerState = {
  zapsBalance: bigint;
  allowance: bigint;
  staked: bigint;
  earnedWeth: bigint;
};

type ReleasedCampaign = {
  campaign: {
    address: Address;
    runtimeCodeHash: string;
    startAt: bigint;
    endAt: bigint;
    claimDeadline: bigint;
  };
};

function readableError(cause: unknown): string {
  if (cause instanceof Error) {
    const short = cause.message.split("\n")[0]?.trim();
    return short && short.length <= 220 ? short : "The action failed before completing.";
  }
  return "The action failed before completing.";
}

/**
 * User staking for campaign 2: stake, withdraw, and claim against the
 * released campaign contract. Manifest-gated like every campaign-2 surface —
 * renders nothing until the reviewed release fills the manifest, then every
 * write runs simulate → wallet review → receipt → runtime-hash re-check.
 * Phase comes from the preflight snapshot's verified block time against the
 * release's immutable schedule, never from the local clock.
 */
export function Campaign2Stake(): React.JSX.Element | null {
  const released =
    feeRewards2Deployment() === "configured"
      ? (FEE_REWARDS_2_MANIFEST.deployment as unknown as ReleasedCampaign)
      : null;

  const { account, connect, providerAvailable, isRobinhoodChain } = useWalletSession();
  const [preflight, setPreflight] = useState<Campaign2Preflight | null>(null);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [amount, setAmount] = useState("");
  const [write, setWrite] = useState<WriteState>({ stage: "idle", label: "", hash: null, message: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const sequence = useRef(0);

  const campaignAddress = released?.campaign.address ?? null;

  const load = useCallback(async (): Promise<void> => {
    if (!campaignAddress) return;
    const mine = ++sequence.current;
    try {
      const response = await fetch("/api/protocol/rewards2", { cache: "no-store" });
      if (!response.ok) throw new Error(`preflight ${response.status}`);
      const data = (await response.json()) as Campaign2Preflight;
      if (mine === sequence.current) setPreflight(data);
    } catch {
      if (mine === sequence.current) setPreflight(null);
    }
    if (!account) {
      setViewer(null);
      return;
    }
    try {
      const provider = getInjectedProvider();
      if (!provider) throw new Error("no provider");
      const publicClient = createPublicClient({ chain: robinhoodChain, transport: custom(provider) });
      const [zapsBalance, allowance, staked, earnedWeth] = await Promise.all([
        publicClient.readContract({
          address: FEE_REWARDS_2_MANIFEST.token,
          abi: permitTokenAbi,
          functionName: "balanceOf",
          args: [account],
        }),
        publicClient.readContract({
          address: FEE_REWARDS_2_MANIFEST.token,
          abi: permitTokenAbi,
          functionName: "allowance",
          args: [account, campaignAddress],
        }),
        publicClient.readContract({
          address: campaignAddress,
          abi: feeRewardsCampaignAbi,
          functionName: "balanceOf",
          args: [account],
        }),
        publicClient.readContract({
          address: campaignAddress,
          abi: feeRewardsCampaignAbi,
          functionName: "earned",
          args: [account, FEE_REWARDS_2_MANIFEST.weth],
        }),
      ]);
      if (mine === sequence.current) setViewer({ zapsBalance, allowance, staked, earnedWeth });
    } catch {
      // Viewer figures stay absent rather than zeroed: an RPC failure must
      // not render as an empty wallet.
      if (mine === sequence.current) setViewer(null);
    }
  }, [account, campaignAddress]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const runContract = useCallback(
    async (
      label: string,
      target: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] },
      expectedRuntimeHash: string | null,
    ): Promise<boolean> => {
      let submittedHash: Hash | null = null;
      setBusy(label);
      setWrite({ stage: "preparing", label, hash: null, message: "Checking the exact call against the connected wallet RPC." });
      try {
        if (!account) throw new Error("Connect a wallet before preparing this action.");
        const provider = getInjectedProvider();
        if (!provider) throw new Error("No injected wallet was found in this browser.");
        await ensureRobinhoodChain(provider);
        const publicClient = createPublicClient({ chain: robinhoodChain, transport: custom(provider) });
        const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: custom(provider) });

        const simulation = await publicClient.simulateContract({
          account,
          address: target.address,
          abi: target.abi,
          functionName: target.functionName,
          args: target.args ?? [],
        } as never);

        setWrite({ stage: "wallet", label, hash: null, message: "Review the exact target and calldata in your wallet. Nothing has been submitted yet." });
        submittedHash = await walletClient.writeContract(simulation.request as never);
        setWrite({ stage: "submitted", label, hash: submittedHash, message: "Submitted. Waiting for a Robinhood Chain receipt." });

        const receipt = await publicClient.waitForTransactionReceipt({ hash: submittedHash });
        if (receipt.status !== "success") {
          setWrite({ stage: "reverted", label, hash: submittedHash, message: "The receipt is final and reverted. No state change was applied." });
          return false;
        }
        if (expectedRuntimeHash) {
          const code = await publicClient.getBytecode({ address: target.address, blockNumber: receipt.blockNumber });
          if (!code || keccak256(code).toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
            setWrite({ stage: "unknown", label, hash: submittedHash, message: "Receipt confirmed, but the target runtime hash no longer matches the release. Inspect before retrying." });
            return false;
          }
        }
        await load();
        setWrite({ stage: "verified", label, hash: submittedHash, message: "Receipt confirmed and balances refreshed." });
        return true;
      } catch (cause) {
        setWrite({
          stage: submittedHash ? "unknown" : "not-submitted",
          label,
          hash: submittedHash,
          message: submittedHash
            ? "A hash exists, but receipt verification was interrupted. Inspect it before retrying."
            : `Nothing was submitted. ${readableError(cause)}`,
        });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [account, load],
  );

  if (!released || !campaignAddress) return null;

  const term = released.campaign;
  const blockTime = preflight ? BigInt(preflight.blockTimestamp) : null;
  const funded = preflight?.live?.campaign.feeSharesFunded ?? false;
  const finalized = preflight?.live?.campaign.finalized ?? false;
  const phase: FeeRewardsPhase | null =
    blockTime !== null
      ? campaignPhase(blockTime, funded, finalized, BigInt(term.startAt), BigInt(term.endAt), BigInt(term.claimDeadline))
      : null;

  const stakingOpen = phase === "upcoming" || phase === "active";
  const claimsOpen = phase !== null && phase !== "unfunded" && phase !== "expired";

  const parsedAmount = ((): bigint | null => {
    try {
      const value = parseUnits(amount === "" ? "0" : amount, 18);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  })();

  const needsApproval =
    viewer !== null && parsedAmount !== null && viewer.allowance < parsedAmount;

  const stake = async (): Promise<void> => {
    if (parsedAmount === null) return;
    if (needsApproval) {
      const ok = await runContract(
        `approve ${amount} 0xZAPS`,
        {
          address: FEE_REWARDS_2_MANIFEST.token,
          abi: permitTokenAbi as unknown as Abi,
          functionName: "approve",
          args: [campaignAddress, parsedAmount],
        },
        null,
      );
      if (!ok) return;
    }
    await runContract(
      `stake ${amount} 0xZAPS`,
      {
        address: campaignAddress,
        abi: feeRewardsCampaignAbi as unknown as Abi,
        functionName: "stake",
        args: [parsedAmount],
      },
      term.runtimeCodeHash,
    );
  };

  const withdraw = async (): Promise<void> => {
    if (parsedAmount === null) return;
    await runContract(
      `withdraw ${amount} 0xZAPS`,
      {
        address: campaignAddress,
        abi: feeRewardsCampaignAbi as unknown as Abi,
        functionName: "withdraw",
        args: [parsedAmount],
      },
      term.runtimeCodeHash,
    );
  };

  const claim = async (): Promise<void> => {
    if (!account) return;
    await runContract(
      "claim rewards",
      {
        address: campaignAddress,
        abi: feeRewardsCampaignAbi as unknown as Abi,
        functionName: "claimFor",
        args: [account],
      },
      term.runtimeCodeHash,
    );
  };

  return (
    <section className={styles.stake} aria-label="Stake in campaign 2">
      <header className={styles.stakeHead}>
        <strong>Stake 0xZAPS</strong>
        <span>
          {phase === null ? "Verifying phase…" : formatCampaignPhase(phase)}
        </span>
      </header>
      {phase !== null && <p className={styles.stakeNote}>{campaignPhaseNote(phase)}</p>}
      {phase === "upcoming" && <p className={styles.stakeNote}>{PRESTAKE_NOTE}</p>}

      {!account ? (
        <div className={styles.walletRow}>
          <button type="button" onClick={() => void connect()} disabled={!providerAvailable}>
            {providerAvailable ? "Connect wallet to stake" : "No wallet detected"}
          </button>
        </div>
      ) : !isRobinhoodChain ? (
        <p className={styles.stakeNote}>Switch the wallet to Robinhood Chain (4663) to continue.</p>
      ) : (
        <>
          <dl className={styles.stakeFigures}>
            <div>
              <dt>Wallet 0xZAPS</dt>
              <dd>{viewer ? formatUnits(viewer.zapsBalance, 18) : "—"}</dd>
            </div>
            <div>
              <dt>Staked</dt>
              <dd>{viewer ? formatUnits(viewer.staked, 18) : "—"}</dd>
            </div>
            <div>
              <dt>Earned WETH</dt>
              <dd>{viewer ? formatUnits(viewer.earnedWeth, 18) : "—"}</dd>
            </div>
          </dl>

          <div className={styles.stakeControls}>
            <input
              type="text"
              inputMode="decimal"
              placeholder="Amount of 0xZAPS"
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
              aria-label="Amount of 0xZAPS"
            />
            <button
              type="button"
              disabled={busy !== null || !stakingOpen || parsedAmount === null}
              onClick={() => void stake()}
            >
              {needsApproval ? "Approve + stake" : "Stake"}
            </button>
            <button
              type="button"
              disabled={busy !== null || parsedAmount === null}
              onClick={() => void withdraw()}
            >
              Withdraw
            </button>
            <button type="button" disabled={busy !== null || !claimsOpen} onClick={() => void claim()}>
              Claim WETH
            </button>
          </div>
        </>
      )}

      {write.stage !== "idle" && (
        <p className={styles.stakeStatus} data-stage={write.stage}>
          <strong>{write.label}</strong> — {write.message}{" "}
          {write.hash && (
            <a href={explorerTransaction(write.hash)} target="_blank" rel="noreferrer">
              receipt
            </a>
          )}
        </p>
      )}

      <p className={styles.boundary}>{STAKE_BOUNDARY}</p>
      <p className={styles.boundary}>{STAKE_RISK}</p>
    </section>
  );
}
