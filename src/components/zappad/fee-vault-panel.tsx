"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, type Address, type Hex } from "viem";
import {
  explorerAddress,
  explorerTransaction,
  ROBINHOOD_CHAIN_ID,
} from "@/lib/zappad/chain";
import { ERC20_ABI, FEE_VAULT_ABI } from "@/lib/zappad/contracts";
import { parseFeeShareTransfer } from "@/lib/zappad/fee-shares";
import {
  formatTokenAmount,
  readableError,
  shortAddress,
} from "@/lib/zappad/launch-math";
import { useZapPadWallet } from "@/lib/zappad/wallet";

interface AssetClaim {
  address: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
}

interface VaultSnapshot {
  balance: bigint;
  totalSupply: bigint;
  claims: AssetClaim[];
}

export function FeeVaultPanel({ vault }: { vault: Address }) {
  const {
    address,
    isConnected,
    chainId,
    publicClient: client,
    switchToRobinhood,
    writeContract: writeContractAsync,
  } = useZapPadWallet();
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<
    "harvest" | "claim" | "transfer" | null
  >(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastTx, setLastTx] = useState<Hex | null>(null);
  const [recipient, setRecipient] = useState("");
  const [shareAmount, setShareAmount] = useState("");
  const loadVersion = useRef(0);
  const activeAddress = useRef(address);

  useEffect(() => {
    activeAddress.current = address;
  }, [address]);

  const load = useCallback(async () => {
    if (
      !client ||
      activeAddress.current?.toLowerCase() !== address?.toLowerCase()
    ) {
      return;
    }
    const version = ++loadVersion.current;
    const requestedAddress = address?.toLowerCase();
    const isCurrent = () =>
      version === loadVersion.current &&
      requestedAddress === activeAddress.current?.toLowerCase();
    setLoading(true);
    setError("");
    try {
      const [assets, balance, totalSupply, claimableResult] = await Promise.all([
        client.readContract({
          address: vault,
          abi: FEE_VAULT_ABI,
          functionName: "revenueAssets",
        }),
        address
          ? client.readContract({
              address: vault,
              abi: FEE_VAULT_ABI,
              functionName: "balanceOf",
              args: [address],
            })
          : Promise.resolve(0n),
        client.readContract({
          address: vault,
          abi: FEE_VAULT_ABI,
          functionName: "totalSupply",
        }),
        address
          ? client.readContract({
              address: vault,
              abi: FEE_VAULT_ABI,
              functionName: "claimableAll",
              args: [address],
            })
          : Promise.resolve([
              [] as readonly Address[],
              [] as readonly bigint[],
            ] as const),
      ]);
      const [claimAssets, claimables] = claimableResult;
      const effectiveAssets = claimAssets.length > 0 ? claimAssets : assets;

      const claims = await Promise.all(
        effectiveAssets.map(async (asset, index): Promise<AssetClaim> => {
          const [symbol, decimals] = await Promise.all([
            client
              .readContract({
                address: asset,
                abi: ERC20_ABI,
                functionName: "symbol",
              })
              .catch(() => shortAddress(asset)),
            client
              .readContract({
                address: asset,
                abi: ERC20_ABI,
                functionName: "decimals",
              })
              .catch(() => 18),
          ]);
          return {
            address: asset,
            symbol,
            decimals,
            amount: claimables[index] ?? 0n,
          };
        }),
      );
      if (isCurrent()) {
        setSnapshot({ balance, totalSupply, claims });
      }
    } catch (reason) {
      if (isCurrent()) {
        setError(readableError(reason));
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
      }
    }
  }, [address, client, vault]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  async function ensureChain() {
    if (chainId === ROBINHOOD_CHAIN_ID) return true;
    try {
      await switchToRobinhood();
      return true;
    } catch (reason) {
      setError(readableError(reason));
      return false;
    }
  }

  async function runAction(next: "harvest" | "claim") {
    if (!client || !address || !(await ensureChain())) return;
    setAction(next);
    setError("");
    setNotice("");
    setLastTx(null);
    try {
      const hash = await writeContractAsync({
        address: vault,
        abi: FEE_VAULT_ABI,
        functionName: next === "harvest" ? "harvest" : "claimAll",
        args: next === "claim" ? [address] : undefined,
        chainId: ROBINHOOD_CHAIN_ID,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted.");
      setLastTx(hash);
      setNotice(
        next === "harvest"
          ? "Pool fees were harvested into the vault."
          : "Available fees were claimed to your wallet.",
      );
      await load();
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setAction(null);
    }
  }

  const parsedTransfer = useMemo(
    () =>
      parseFeeShareTransfer({
        recipient,
        amount: shareAmount,
        balance: snapshot?.balance ?? 0n,
        holder: address ?? undefined,
      }),
    [address, recipient, shareAmount, snapshot?.balance],
  );

  async function transferShares() {
    if (!client || !address) return;
    if (!parsedTransfer.valid) {
      setError(parsedTransfer.error);
      return;
    }
    if (!(await ensureChain())) return;

    setAction("transfer");
    setError("");
    setNotice("");
    setLastTx(null);
    try {
      const simulation = await client.simulateContract({
        account: address,
        address: vault,
        abi: FEE_VAULT_ABI,
        functionName: "transfer",
        args: [parsedTransfer.recipient, parsedTransfer.amount],
      });
      const hash = await writeContractAsync({
        ...simulation.request,
        chainId: ROBINHOOD_CHAIN_ID,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted.");

      setLastTx(hash);
      setNotice(
        `${formatTokenAmount(parsedTransfer.amount, 18, 6)} fee shares transferred to ${shortAddress(parsedTransfer.recipient, 8, 6)}.`,
      );
      setShareAmount("");
      await load();
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setAction(null);
    }
  }

  const hasClaim = snapshot?.claims.some((claim) => claim.amount > 0n) ?? false;
  const sharePct =
    snapshot && snapshot.totalSupply > 0n
      ? Number((snapshot.balance * 1_000_000n) / snapshot.totalSupply) / 10_000
      : 0;

  return (
    <section className="vault-panel" aria-busy={loading || Boolean(action)}>
      <div className="vault-panel-head">
        <div>
          <div className="eyebrow">Fee-share vault</div>
          <h2>Claim the cash flow.</h2>
        </div>
        <a href={explorerAddress(vault)} rel="noreferrer" target="_blank">
          {shortAddress(vault, 8, 6)} ↗
        </a>
      </div>

      <div className="vault-metrics">
        <div>
          <span>Your vault ownership</span>
          <strong>{isConnected ? `${sharePct.toLocaleString()}%` : "Connect"}</strong>
          <small>
            {snapshot
              ? `${formatTokenAmount(snapshot.balance, 18, 4)} fee shares`
              : "—"}
          </small>
        </div>
        {(snapshot?.claims ?? []).map((claim) => (
          <div key={claim.address}>
            <span>Claimable {claim.symbol}</span>
            <strong>
              {loading
                ? "…"
                : formatTokenAmount(claim.amount, claim.decimals, 6)}
            </strong>
            <small>{shortAddress(claim.address)}</small>
          </div>
        ))}
      </div>

      {error && (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice notice-success" role="status">
          {notice}
          {lastTx && (
            <a href={explorerTransaction(lastTx)} rel="noreferrer" target="_blank">
              View transaction ↗
            </a>
          )}
        </div>
      )}
      <div className="vault-actions">
        <button
          className="button button-secondary"
          disabled={!isConnected || Boolean(action)}
          onClick={() => runAction("harvest")}
          type="button"
        >
          {action === "harvest" ? "Harvesting…" : "Harvest pool fees"}
        </button>
        <button
          className="button button-primary"
          disabled={!isConnected || !hasClaim || Boolean(action)}
          onClick={() => runAction("claim")}
          type="button"
        >
          {action === "claim" ? "Claiming…" : "Claim all"}
        </button>
      </div>
      <p>
        Harvest is permissionless and moves earned LP fees into the vault.
        Claiming pays only the connected wallet’s accounted share.
      </p>

      <form
        className="vault-transfer"
        onSubmit={(event) => {
          event.preventDefault();
          void transferShares();
        }}
      >
        <div className="vault-transfer-head">
          <div>
            <strong>Transfer fee rights</strong>
            <span>
              Accrued fees stay with the sender. Future checkpointed fees follow
              the shares.
            </span>
          </div>
          <button
            className="button button-quiet button-small"
            disabled={!snapshot || snapshot.balance === 0n || Boolean(action)}
            onClick={() =>
              setShareAmount(formatUnits(snapshot?.balance ?? 0n, 18))
            }
            type="button"
          >
            Use max
          </button>
        </div>
        <div className="vault-transfer-grid">
          <label className="field">
            <span>Recipient address</span>
            <input
              autoComplete="off"
              disabled={Boolean(action)}
              onChange={(event) => setRecipient(event.target.value)}
              placeholder="0x…"
              spellCheck={false}
              value={recipient}
            />
          </label>
          <label className="field">
            <span>
              Fee shares
              <small>
                {formatTokenAmount(snapshot?.balance, 18, 4)} available
              </small>
            </span>
            <input
              disabled={Boolean(action)}
              inputMode="decimal"
              onChange={(event) => setShareAmount(event.target.value)}
              placeholder="0.0"
              value={shareAmount}
            />
          </label>
          <button
            className="button button-secondary"
            disabled={
              !isConnected ||
              !parsedTransfer.valid ||
              Boolean(action)
            }
            type="submit"
          >
            {action === "transfer" ? "Transferring…" : "Transfer shares"}
          </button>
        </div>
        {(recipient.trim() || shareAmount.trim()) && !parsedTransfer.valid && (
          <span className="vault-transfer-error">{parsedTransfer.error}</span>
        )}
      </form>
    </section>
  );
}
