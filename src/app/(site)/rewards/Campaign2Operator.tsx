"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  keccak256,
  type Abi,
  type Address,
  type Hash,
} from "viem";

import { useWalletSession } from "@/components/WalletProvider";
import { feeRewardsCampaignAbi, feeRewardsVaultAbi } from "@/lib/rewards";
import { FEE_REWARDS_2_MANIFEST, hookBlocksAbi } from "@/lib/rewards2";
import type { Campaign2Preflight } from "@/lib/rewards2-server";
import {
  ensureRobinhoodChain,
  explorerTransaction,
  getInjectedProvider,
  robinhoodChain,
} from "@/lib/robinhood";
import styles from "./campaign2.module.css";

const REFRESH_MS = 60_000;

type PreflightState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; data: Campaign2Preflight };

type OpStage =
  | "idle"
  | "preparing"
  | "wallet"
  | "submitted"
  | "reverted"
  | "verified"
  | "unknown"
  | "not-submitted";

type OpAction = {
  stage: OpStage;
  label: string;
  hash: Hash | null;
  message: string;
};

type OperatorOpId =
  | "buyAndBurn"
  | "pause"
  | "hb-finalize"
  | "sweep"
  | "harvest"
  | "c-finalize"
  | "fund-hb"
  | "fund-campaign";

type OperatorOp = {
  id: OperatorOpId;
  label: string;
  sponsorOnly: boolean;
  description: string;
};

type ReleasedManifest = {
  campaign: { address: Address; runtimeCodeHash: string };
  hookBlocks: { address: Address; runtimeCodeHash: string };
};

function readableError(cause: unknown): string {
  if (cause instanceof Error) {
    const short = cause.message.split("\n")[0]?.trim();
    return short && short.length <= 220 ? short : "The action failed before completing.";
  }
  return "The action failed before completing.";
}

/**
 * The campaign-2 operator console. Read side works TODAY: it renders the
 * block-pinned preflight snapshot (`/api/protocol/rewards2`) that proves the
 * runbook preconditions live. The write side stays disabled until the
 * reviewed release fills `FEE_REWARDS_2_MANIFEST.deployment`; every write
 * then runs simulate → wallet review → receipt → runtime-hash check →
 * preflight refetch, mirroring the campaign-1 operate console. Sponsor-only
 * levers are labelled and additionally enforced by the contracts themselves.
 */
export function Campaign2Operator(): React.JSX.Element {
  const { account, connect, providerAvailable, isRobinhoodChain } = useWalletSession();
  const [preflight, setPreflight] = useState<PreflightState>({ status: "loading" });
  const [action, setAction] = useState<OpAction>({ stage: "idle", label: "", hash: null, message: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++sequence.current;
    try {
      const response = await fetch("/api/protocol/rewards2", { cache: "no-store" });
      if (!response.ok) throw new Error(`preflight ${response.status}`);
      const data = (await response.json()) as Campaign2Preflight;
      if (mine !== sequence.current) return;
      setPreflight({ status: "ready", data });
    } catch {
      if (mine !== sequence.current) return;
      setPreflight({ status: "unavailable" });
    }
  }, []);

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

  const clients = useCallback(async () => {
    if (!account) throw new Error("Connect a wallet before preparing this action.");
    const provider = getInjectedProvider();
    if (!provider) throw new Error("No injected wallet was found in this browser.");
    await ensureRobinhoodChain(provider);
    return {
      publicClient: createPublicClient({ chain: robinhoodChain, transport: custom(provider) }),
      walletClient: createWalletClient({ account, chain: robinhoodChain, transport: custom(provider) }),
    };
  }, [account]);

  const runContract = useCallback(
    async (
      label: string,
      target: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] },
      expectedRuntimeHash: string | null,
    ): Promise<boolean> => {
      let submittedHash: Hash | null = null;
      setBusy(label);
      setAction({ stage: "preparing", label, hash: null, message: "Checking the exact call against the connected wallet RPC." });
      try {
        const { publicClient, walletClient } = await clients();
        const simulation = await publicClient.simulateContract({
          account,
          address: target.address,
          abi: target.abi,
          functionName: target.functionName,
          args: target.args ?? [],
        } as never);

        setAction({ stage: "wallet", label, hash: null, message: "Review the exact target and calldata in your wallet. Nothing has been submitted yet." });
        submittedHash = await walletClient.writeContract(simulation.request as never);
        setAction({ stage: "submitted", label, hash: submittedHash, message: "Submitted. Waiting for a Robinhood Chain receipt." });

        const receipt = await publicClient.waitForTransactionReceipt({ hash: submittedHash });
        if (receipt.status !== "success") {
          setAction({ stage: "reverted", label, hash: submittedHash, message: "The receipt is final and reverted. No state change was applied." });
          return false;
        }
        if (expectedRuntimeHash) {
          const code = await publicClient.getBytecode({ address: target.address, blockNumber: receipt.blockNumber });
          if (!code || keccak256(code).toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
            setAction({ stage: "unknown", label, hash: submittedHash, message: "Receipt confirmed, but the target runtime hash no longer matches the release. Inspect before retrying." });
            return false;
          }
        }
        await load();
        setAction({ stage: "verified", label, hash: submittedHash, message: "Receipt confirmed and the preflight snapshot refreshed." });
        return true;
      } catch (cause) {
        setAction({
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
    [account, clients, load],
  );

  const manifest = FEE_REWARDS_2_MANIFEST;
  const data = preflight.status === "ready" ? preflight.data : null;
  const released = data?.deployment === "configured" && data.live ? data.live : null;
  const releasedManifest = manifest.deployment as unknown as ReleasedManifest | null;
  const sponsorConnected = !!account && account.toLowerCase() === manifest.sponsor.toLowerCase();
  const buybackPaused = released?.hookBlocks.buybackPaused ?? false;

  const fundLeg = useCallback(
    async (legLabel: string, spender: Address, spenderAbi: Abi, expectedRuntimeHash: string): Promise<void> => {
      // Exact-approval then fund, the runbook sequence; the second step only
      // fires if the first verified.
      const approved = await runContract(
        `${legLabel}: exact 50-share approval`,
        {
          address: manifest.vault.address,
          abi: feeRewardsVaultAbi as unknown as Abi,
          functionName: "approve",
          args: [spender, manifest.terms.stakerFeeShares],
        },
        null,
      );
      if (!approved) return;
      await runContract(
        `${legLabel}: fundFeeShares(50e18)`,
        { address: spender, abi: spenderAbi, functionName: "fundFeeShares", args: [manifest.terms.stakerFeeShares] },
        expectedRuntimeHash,
      );
    },
    [manifest, runContract],
  );

  const runOp = useCallback(
    async (id: OperatorOpId): Promise<void> => {
      if (!releasedManifest) return;
      const hb = releasedManifest.hookBlocks;
      const campaign = releasedManifest.campaign;
      switch (id) {
        case "buyAndBurn":
          await runContract(
            "buyAndBurn(0)",
            { address: hb.address, abi: hookBlocksAbi as unknown as Abi, functionName: "buyAndBurn", args: [0n] },
            hb.runtimeCodeHash,
          );
          return;
        case "pause":
          await runContract(
            buybackPaused ? "setBuybackPaused(false)" : "setBuybackPaused(true)",
            {
              address: hb.address,
              abi: hookBlocksAbi as unknown as Abi,
              functionName: "setBuybackPaused",
              args: [!buybackPaused],
            },
            hb.runtimeCodeHash,
          );
          return;
        case "hb-finalize":
          await runContract(
            "hookBlocks.finalize()",
            { address: hb.address, abi: hookBlocksAbi as unknown as Abi, functionName: "finalize" },
            hb.runtimeCodeHash,
          );
          return;
        case "sweep":
          await runContract(
            "sweepUnspent()",
            { address: hb.address, abi: hookBlocksAbi as unknown as Abi, functionName: "sweepUnspent" },
            hb.runtimeCodeHash,
          );
          return;
        case "harvest":
          await runContract(
            "campaign.harvest()",
            { address: campaign.address, abi: feeRewardsCampaignAbi as unknown as Abi, functionName: "harvest" },
            campaign.runtimeCodeHash,
          );
          return;
        case "c-finalize":
          await runContract(
            "campaign.finalize()",
            { address: campaign.address, abi: feeRewardsCampaignAbi as unknown as Abi, functionName: "finalize" },
            campaign.runtimeCodeHash,
          );
          return;
        case "fund-hb":
          await fundLeg("Hook Blocks", hb.address, hookBlocksAbi as unknown as Abi, hb.runtimeCodeHash);
          return;
        case "fund-campaign":
          await fundLeg(
            "Staker campaign",
            campaign.address,
            feeRewardsCampaignAbi as unknown as Abi,
            campaign.runtimeCodeHash,
          );
          return;
      }
    },
    [buybackPaused, fundLeg, releasedManifest, runContract],
  );

  const ops: OperatorOp[] = [
    {
      id: "buyAndBurn",
      label: "Buy + burn HOOKR",
      sponsorOnly: false,
      description:
        "Claims the leg's vault WETH, market-buys HOOKR on the pinned pool (spot×0.97 floor, ≤0.05 ETH, one per block), and burns it to the dead address in the same transaction.",
    },
    {
      id: "pause",
      label: buybackPaused ? "Unpause buybacks" : "Pause buybacks",
      sponsorOnly: true,
      description:
        "Circuit breaker for future buyAndBurn() calls only — funding, finalize, and the sweep are never behind it, and it cannot move any asset.",
    },
    {
      id: "hb-finalize",
      label: "Finalize Hook Blocks leg",
      sponsorOnly: false,
      description:
        "After the window: one final reward pull, then the 50 shares return to the sponsor. Residual WETH stays convertible.",
    },
    {
      id: "sweep",
      label: "Sweep unconverted residue",
      sponsorOnly: false,
      description:
        "Recovers residual WETH/ETH to the sponsor — the sponsor from the term's end, anyone from thirty days later. Burned HOOKR is already at the dead address and out of reach.",
    },
    {
      id: "harvest",
      label: "Harvest staker leg",
      sponsorOnly: false,
      description:
        "Pulls accrued vault WETH into the staking campaign and schedules it to the fixed end — permissionless upkeep, campaign-1 semantics.",
    },
    {
      id: "c-finalize",
      label: "Finalize staker leg",
      sponsorOnly: false,
      description:
        "After the window: settles rewards at frozen end-of-window weights and returns the 50 shares to the sponsor. Claims stay open to the deadline.",
    },
    {
      id: "fund-hb",
      label: "Fund Hook Blocks leg (50 shares)",
      sponsorOnly: true,
      description:
        "Exact 50-share approval, then fundFeeShares — sponsor only, strictly before the start. The contract refuses anything else.",
    },
    {
      id: "fund-campaign",
      label: "Fund staker leg (50 shares)",
      sponsorOnly: true,
      description:
        "Exact 50-share approval, then fundFeeShares on the new campaign term — sponsor only, strictly before the start.",
    },
  ];

  const writesLive = releasedManifest !== null;

  return (
    <div className={styles.operator} aria-label="Campaign 2 operator console">
      <header className={styles.operatorHead}>
        <strong>Operator console</strong>
        <span>
          {writesLive
            ? "Release configured — writes enabled"
            : "Preflight live now · writes arrive with the release"}
        </span>
      </header>

      {preflight.status === "loading" ? (
        <p className={styles.operatorNote}>Reading the block-pinned preflight snapshot…</p>
      ) : null}
      {preflight.status === "unavailable" ? (
        <p className={styles.operatorNote} role="alert">
          The preflight snapshot is unavailable. Nothing is assumed and no figures are shown;
          retry shortly.
        </p>
      ) : null}

      {data ? (
        <>
          <ul className={styles.checks}>
            {data.checks.map((check) => (
              <li key={check.id} data-ok={check.ok ? "" : undefined}>
                <i aria-hidden />
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className={styles.figures}>
            Sponsor shares {formatUnits(BigInt(data.figures.sponsorShares), 18)} of 100 · pending
            locker fees {formatUnits(BigInt(data.figures.pendingLockerWeth), 18)} WETH · spot ~
            {(Number(data.figures.hookrPerEthMilli) / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })}{" "}
            HOOKR/ETH · block {data.headBlock}
          </p>
          {released ? (
            <p className={styles.figures}>
              Hook Blocks: {released.hookBlocks.blockCount} blocks ·{" "}
              {formatUnits(BigInt(released.hookBlocks.totalHookrBought), 18)} HOOKR bought /{" "}
              {formatUnits(BigInt(released.hookBlocks.totalHookrBurned), 18)} burned ·{" "}
              {formatUnits(BigInt(released.hookBlocks.pendingWeth), 18)} WETH pending ·{" "}
              {released.hookBlocks.buybackPaused ? "buybacks PAUSED" : "buybacks open"} · staker leg{" "}
              {formatUnits(BigInt(released.campaign.totalStaked), 18)} 0xZAPS staked
            </p>
          ) : null}
        </>
      ) : null}

      <div className={styles.walletRow}>
        {account ? (
          <span>
            Connected {account.slice(0, 6)}…{account.slice(-4)}
            {sponsorConnected ? " (sponsor)" : ""}
            {!isRobinhoodChain ? " — switch to Robinhood Chain" : ""}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void connect().catch(() => undefined)}
            disabled={!providerAvailable}
          >
            {providerAvailable ? "Connect wallet" : "No injected wallet found"}
          </button>
        )}
      </div>

      <ul className={styles.opsList}>
        {ops.map((op) => {
          const disabled =
            busy !== null || !writesLive || !account || (op.sponsorOnly && !sponsorConnected);
          return (
            <li key={op.id}>
              <div>
                <strong>
                  {op.label}
                  {op.sponsorOnly ? <em> sponsor</em> : null}
                </strong>
                <span>{op.description}</span>
              </div>
              <button type="button" disabled={disabled} onClick={() => void runOp(op.id)}>
                {busy !== null ? "Working…" : writesLive ? "Prepare" : "Not live"}
              </button>
            </li>
          );
        })}
      </ul>

      {action.stage !== "idle" ? (
        <p className={styles.actionState} data-stage={action.stage}>
          <strong>{action.label}</strong> — {action.message}{" "}
          {action.hash ? (
            <a href={explorerTransaction(action.hash)} target="_blank" rel="noreferrer">
              receipt
            </a>
          ) : null}
        </p>
      ) : null}

      <p className={styles.operatorNote}>
        Every write simulates first, shows the exact call in the wallet, waits for a receipt, and
        re-verifies the target&apos;s runtime hash against the release before the snapshot refreshes.
        Sponsor-only levers are also enforced by the contracts; this console only labels them.
      </p>
    </div>
  );
}
