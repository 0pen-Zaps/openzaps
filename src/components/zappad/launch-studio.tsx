"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  decodeEventLog,
  formatUnits,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import {
  explorerAddress,
  explorerTransaction,
  FEE_TIERS,
  PAIR_ASSETS,
  ROBINHOOD_CHAIN_ID,
  USDG_ADDRESS,
  WETH_ADDRESS,
} from "@/lib/zappad/chain";
import { exactAllowancePlan } from "@/lib/zappad/allowance";
import { ERC20_ABI, LAUNCHER_ABI } from "@/lib/zappad/contracts";
import {
  isSortedBelow,
  isRecoverableLaunchSaltError,
  marketCapToFloorTick,
  parseMetadataUri,
  predictFactoryTokenAddress,
  randomSalt,
  readableError,
  shortAddress,
} from "@/lib/zappad/launch-math";
import { useZapPadWallet } from "@/lib/zappad/wallet";
import { useRuntimeConfig } from "./runtime-config-provider";

type Phase =
  | "idle"
  | "mining"
  | "approving"
  | "simulating"
  | "ready"
  | "submitting"
  | "confirming"
  | "success";

interface MinedIdentity {
  salt: Hex;
  token: Address;
  identityKey: string;
  attempts: number;
}

interface LaunchResult {
  token: Address;
  creator: Address;
  protocolTreasury: Address;
  feeVault: Address;
  pool: Address;
  positionId: bigint;
  pairedAsset: Address;
  feeTier: number;
  floorTick: number;
  name: string;
  symbol: string;
  metadataURI: string;
  salt: Hex;
  firstBuyPairIn: bigint;
  minFirstBuyTokensOut: bigint;
  nativeValue: bigint;
  configHash: Hex;
  launchedAt: bigint;
  firstBuyAmountIn: bigint;
  firstBuyAmountOut: bigint;
  hash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
}

interface TreasuryRead {
  launcher: Address;
  treasury: Address;
}

interface TreasuryFailure {
  launcher: Address;
  message: string;
}

export interface SpenderAllowance {
  owner: Address;
  spender: Address;
  amount: bigint;
}

function sameAddress(left: Address, right: Address) {
  return left.toLowerCase() === right.toLowerCase();
}

export function allowanceAuthorityKey(owner: Address, spender: Address) {
  return `${owner.toLowerCase()}:${spender.toLowerCase()}`;
}

/**
 * Keep only verified nonzero allowances, keyed by owner and authorized spender.
 *
 * Runtime deployment changes must not reinterpret launcher A's amount as an
 * allowance for launcher B, and wallet changes must not reinterpret owner A's
 * amount as owner B's authority. A zero read removes only its exact pair.
 */
export function recordSpenderAllowance(
  current: readonly SpenderAllowance[],
  owner: Address,
  spender: Address,
  amount: bigint,
): SpenderAllowance[] {
  const retained = current.filter(
    (allowance) =>
      allowanceAuthorityKey(allowance.owner, allowance.spender) !==
      allowanceAuthorityKey(owner, spender),
  );
  return amount > 0n ? [...retained, { owner, spender, amount }] : retained;
}

export function spenderAllowance(
  allowances: readonly SpenderAllowance[],
  owner: Address,
  spender: Address,
): SpenderAllowance | null {
  return (
    allowances.find(
      (allowance) =>
        allowanceAuthorityKey(allowance.owner, allowance.spender) ===
        allowanceAuthorityKey(owner, spender),
    ) ??
    null
  );
}

export function ownerAllowances(
  allowances: readonly SpenderAllowance[],
  owner: Address,
): SpenderAllowance[] {
  return allowances.filter((allowance) => sameAddress(allowance.owner, owner));
}

function formFingerprint(values: Record<string, string | number | bigint | undefined>) {
  return JSON.stringify(values, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

export function LaunchStudio() {
  const {
    config,
    loading: configLoading,
    error: configError,
    verify: verifyRuntimeConfig,
  } = useRuntimeConfig();
  const readLauncher =
    config?.readEnabled && config.launcherAddress
      ? config.launcherAddress
      : null;
  const launcher =
    config?.launchEnabled && readLauncher ? readLauncher : null;
  const {
    address,
    chainId,
    isConnected,
    publicClient: client,
    connecting,
    switching,
    connect,
    switchToRobinhood,
    writeContract: writeContractAsync,
  } = useZapPadWallet();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [metadataURI, setMetadataURI] = useState("");
  const [pairedAsset, setPairedAsset] = useState<Address>(WETH_ADDRESS);
  const [feeTier, setFeeTier] = useState(10_000);
  const [marketCap, setMarketCap] = useState("5");
  const [firstBuy, setFirstBuy] = useState("");
  const [minimumTokens, setMinimumTokens] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [mined, setMined] = useState<MinedIdentity | null>(null);
  const [simulatedFingerprint, setSimulatedFingerprint] = useState("");
  const [approvalNeededFingerprint, setApprovalNeededFingerprint] = useState("");
  const [usdgAllowances, setUsdgAllowances] = useState<SpenderAllowance[]>([]);
  const [allowanceActionSpender, setAllowanceActionSpender] =
    useState<Address | null>(null);
  const [error, setError] = useState("");
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [treasuryRead, setTreasuryRead] = useState<TreasuryRead | null>(null);
  const [treasuryFailure, setTreasuryFailure] =
    useState<TreasuryFailure | null>(null);
  const miningRun = useRef(0);
  const miningKey = useRef("");
  const allowanceRuns = useRef(new Map<string, number>());
  const lastVerifiedLauncher = useRef<Address | null>(null);
  const activeAllowanceSpender =
    readLauncher ?? lastVerifiedLauncher.current;
  const currentOwnerAllowances = address
    ? ownerAllowances(usdgAllowances, address)
    : [];
  const protocolTreasury =
    launcher &&
    treasuryRead?.launcher.toLowerCase() === launcher.toLowerCase()
      ? treasuryRead.treasury
      : null;
  const treasuryError =
    launcher &&
    treasuryFailure?.launcher.toLowerCase() === launcher.toLowerCase()
      ? treasuryFailure.message
      : "";

  const pair =
    PAIR_ASSETS.find(
      (candidate) => candidate.address.toLowerCase() === pairedAsset.toLowerCase(),
    ) ?? PAIR_ASSETS[0];
  const marketCapNumber = Number(marketCap);
  const floorTick = marketCapToFloorTick(marketCapNumber, pair.decimals, feeTier);
  const normalizedSymbol = symbol.trim().toUpperCase();

  const firstBuyAmount = useMemo(() => {
    try {
      return firstBuy.trim() ? parseUnits(firstBuy.trim(), pair.decimals) : 0n;
    } catch {
      return 0n;
    }
  }, [firstBuy, pair.decimals]);

  const minimumTokensOut = useMemo(() => {
    try {
      return minimumTokens.trim() ? parseUnits(minimumTokens.trim(), 18) : 0n;
    } catch {
      return 0n;
    }
  }, [minimumTokens]);

  const identityKey = [
    address ?? "",
    launcher ?? "",
    name.trim(),
    normalizedSymbol,
    metadataURI.trim(),
    pairedAsset.toLowerCase(),
  ].join("|");
  const currentMined = mined?.identityKey === identityKey ? mined : null;

  const validation = useMemo(() => {
    const issues: string[] = [];
    if (name.trim().length < 2 || name.trim().length > 48) {
      issues.push("Name must be 2–48 characters.");
    }
    if (!/^[A-Z0-9]{2,12}$/.test(normalizedSymbol)) {
      issues.push("Symbol must be 2–12 letters or numbers.");
    }
    const metadata = parseMetadataUri(metadataURI);
    if (!metadata.valid) {
      issues.push(metadata.error ?? "Metadata URI is invalid.");
    }
    if (!Number.isFinite(marketCapNumber) || marketCapNumber <= 0) {
      issues.push("Opening market cap must be greater than zero.");
    }
    if (firstBuy.trim() && firstBuyAmount <= 0n) {
      issues.push("First buy is not a valid positive amount.");
    }
    if (firstBuyAmount > 0n && minimumTokensOut <= 0n) {
      issues.push("Set a minimum token output for the first buy.");
    }
    if (firstBuyAmount === 0n && minimumTokensOut > 0n) {
      issues.push("Clear minimum output when no first buy is set.");
    }
    if (!isAddress(pairedAsset)) issues.push("Pair asset is invalid.");
    return issues;
  }, [
    firstBuy,
    firstBuyAmount,
    marketCapNumber,
    metadataURI,
    minimumTokensOut,
    normalizedSymbol,
    pairedAsset,
    name,
  ]);

  const launchParams = useMemo(
    () =>
      currentMined
        ? {
            name: name.trim(),
            symbol: normalizedSymbol,
            metadataURI: metadataURI.trim(),
            salt: currentMined.salt,
            floorTick,
            pairedAsset,
            feeTier,
            firstBuyPairIn: pair.kind === "native" ? 0n : firstBuyAmount,
            minFirstBuyTokensOut: minimumTokensOut,
          }
        : null,
    [
      feeTier,
      firstBuyAmount,
      floorTick,
      metadataURI,
      currentMined,
      minimumTokensOut,
      name,
      normalizedSymbol,
      pairedAsset,
      pair.kind,
    ],
  );

  const exactFingerprint = useMemo(
    () =>
      launchParams
        ? formFingerprint({
            ...launchParams,
            creator: address ?? undefined,
            launcher: launcher ?? undefined,
            protocolTreasury: protocolTreasury ?? undefined,
            value: pair.kind === "native" ? firstBuyAmount : 0n,
          })
        : "",
    [
      address,
      firstBuyAmount,
      launchParams,
      launcher,
      pair.kind,
      protocolTreasury,
    ],
  );

  const wrongChain = isConnected && chainId !== ROBINHOOD_CHAIN_ID;
  const inputReady =
    validation.length === 0 &&
    Boolean(address && launcher && client && protocolTreasury) &&
    !wrongChain &&
    currentMined !== null;
  const simulationFresh =
    Boolean(exactFingerprint) && exactFingerprint === simulatedFingerprint;
  const needsApproval =
    Boolean(exactFingerprint) && approvalNeededFingerprint === exactFingerprint;

  const mineIdentity = useCallback(async () => {
    if (
      !address ||
      !launcher ||
      !client ||
      validation.some((issue) => issue.includes("Name") || issue.includes("Symbol") || issue.includes("Metadata"))
    ) {
      return;
    }

    const run = ++miningRun.current;
    miningKey.current = identityKey;
    setMined(null);
    setError("");
    setPhase("mining");
    let attempts = 0;

    try {
      const [factory, initCodeHash] = await Promise.all([
        client.readContract({
          address: launcher,
          abi: LAUNCHER_ABI,
          functionName: "tokenFactory",
        }),
        client.readContract({
          address: launcher,
          abi: LAUNCHER_ABI,
          functionName: "tokenInitCodeHash",
          args: [name.trim(), normalizedSymbol, metadataURI.trim(), address],
        }),
      ]);

      for (let round = 0; round < 400; round += 1) {
        let candidate: { salt: Hex; token: Address } | null = null;
        for (let index = 0; index < 256; index += 1) {
          const salt = randomSalt();
          const token = predictFactoryTokenAddress({
            factory,
            creator: address,
            userSalt: salt,
            initCodeHash,
          });
          attempts += 1;
          if (isSortedBelow(token, pairedAsset)) {
            candidate = { salt, token };
            break;
          }
        }
        if (run !== miningRun.current) return;
        if (candidate) {
          const verified = await client.readContract({
            address: launcher,
            abi: LAUNCHER_ABI,
            functionName: "predictTokenAddress",
            args: [
              address,
              candidate.salt,
              name.trim(),
              normalizedSymbol,
              metadataURI.trim(),
            ],
          });
          if (verified.toLowerCase() !== candidate.token.toLowerCase()) {
            throw new Error("Local CREATE2 prediction did not match the launcher.");
          }
          const existingCode = await client.getBytecode({ address: verified });
          if (existingCode) continue;
          setMined({
            salt: candidate.salt,
            token: verified,
            identityKey,
            attempts,
          });
          miningKey.current = "";
          setPhase("idle");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("No sorted CREATE2 address was found in the bounded search.");
    } catch (reason) {
      if (run !== miningRun.current) return;
      miningKey.current = "";
      setError(readableError(reason));
      setPhase("idle");
    }
  }, [
    address,
    client,
    identityKey,
    launcher,
    metadataURI,
    name,
    normalizedSymbol,
    pairedAsset,
    validation,
  ]);

  useEffect(() => {
    miningRun.current += 1;
    miningKey.current = "";
  }, [identityKey]);

  useEffect(() => {
    if (readLauncher) lastVerifiedLauncher.current = readLauncher;
  }, [readLauncher]);

  const refreshUsdgAllowance = useCallback(async (spender?: Address | null) => {
    const requestedOwner = address;
    const requestedSpender = spender ?? activeAllowanceSpender;
    if (!requestedOwner || !requestedSpender || !client) {
      return null;
    }
    const authorityKey = allowanceAuthorityKey(
      requestedOwner,
      requestedSpender,
    );
    const run = (allowanceRuns.current.get(authorityKey) ?? 0) + 1;
    allowanceRuns.current.set(authorityKey, run);

    try {
      const allowance = await client.readContract({
        address: USDG_ADDRESS,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [requestedOwner, requestedSpender],
      });
      if (run === allowanceRuns.current.get(authorityKey)) {
        setUsdgAllowances((current) =>
          recordSpenderAllowance(
            current,
            requestedOwner,
            requestedSpender,
            allowance,
          ),
        );
      }
      return allowance;
    } catch {
      return null;
    }
  }, [activeAllowanceSpender, address, client]);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => void refreshUsdgAllowance(activeAllowanceSpender),
      0,
    );
    return () => window.clearTimeout(timeout);
  }, [activeAllowanceSpender, refreshUsdgAllowance]);

  useEffect(() => {
    let cancelled = false;
    if (!launcher || !client) return;

    void client
      .readContract({
        address: launcher,
        abi: LAUNCHER_ABI,
        functionName: "protocolTreasury",
      })
      .then((treasury) => {
        if (!cancelled) {
          setTreasuryRead({ launcher, treasury });
          setTreasuryFailure(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setTreasuryFailure({
            launcher,
            message: `Protocol treasury could not be read: ${readableError(reason)}`,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, launcher]);

  useEffect(() => {
    if (
      !address ||
      !launcher ||
      !client ||
      currentMined ||
      miningKey.current === identityKey ||
      validation.some((issue) => issue.includes("Name") || issue.includes("Symbol") || issue.includes("Metadata"))
    ) {
      return;
    }
    const timeout = setTimeout(() => void mineIdentity(), 500);
    return () => clearTimeout(timeout);
  }, [address, client, currentMined, identityKey, launcher, mineIdentity, validation]);

  async function connectWallet() {
    setError("");
    try {
      await connect();
    } catch (reason) {
      setError(readableError(reason));
    }
  }

  async function switchNetwork() {
    setError("");
    try {
      await switchToRobinhood();
    } catch (reason) {
      setError(readableError(reason));
    }
  }

  async function checkAllowance() {
    if (
      !address ||
      !launcher ||
      !client ||
      pair.kind !== "erc20" ||
      firstBuyAmount === 0n
    ) {
      return true;
    }
    const allowance = await refreshUsdgAllowance(launcher);
    if (allowance === null) {
      setApprovalNeededFingerprint(exactFingerprint);
      setError("USDG allowance could not be verified. Try the pre-flight again.");
      return false;
    }
    const exact = exactAllowancePlan(allowance, firstBuyAmount).isExact;
    setApprovalNeededFingerprint(exact ? "" : exactFingerprint);
    return exact;
  }

  async function requireFreshWriteRuntime() {
    if (!launcher || !config || config.deployBlock <= 0) {
      throw new Error("ZapPad launch writes are not active.");
    }
    const expectedLauncher = launcher.toLowerCase();
    const expectedDeployBlock = config.deployBlock;
    const fresh = await verifyRuntimeConfig();
    if (
      !fresh.readEnabled ||
      !fresh.launchEnabled ||
      !fresh.launcherAddress ||
      fresh.launcherAddress.toLowerCase() !== expectedLauncher ||
      fresh.deployBlock !== expectedDeployBlock
    ) {
      setSimulatedFingerprint("");
      setApprovalNeededFingerprint("");
      throw new Error(
        "ZapPad launch writes were disabled or the verified deployment changed. Re-run pre-flight after the runtime is restored.",
      );
    }
  }

  async function requireExactUsdgAllowanceForLaunch() {
    if (pair.kind !== "erc20" || firstBuyAmount === 0n) return;
    const allowance = await refreshUsdgAllowance(launcher);
    if (allowance !== firstBuyAmount) {
      setSimulatedFingerprint("");
      setApprovalNeededFingerprint(exactFingerprint);
      throw new Error(
        "USDG allowance changed after pre-flight. Reset it to the exact first-buy amount before launching.",
      );
    }
  }

  async function approveExactFirstBuy() {
    if (
      !address ||
      !launcher ||
      !client ||
      pair.kind !== "erc20" ||
      firstBuyAmount <= 0n ||
      (phase !== "idle" && phase !== "ready")
    ) {
      return;
    }
    setError("");
    setPhase("approving");
    try {
      await requireFreshWriteRuntime();
      const current = await refreshUsdgAllowance(launcher);
      if (current === null) {
        throw new Error("USDG allowance could not be read.");
      }
      const plan = exactAllowancePlan(current, firstBuyAmount);
      if (plan.resetBeforeApproval) {
        await requireFreshWriteRuntime();
        const resetHash = await writeContractAsync({
          address: USDG_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [launcher, 0n],
          chainId: ROBINHOOD_CHAIN_ID,
        });
        const resetReceipt = await client.waitForTransactionReceipt({
          hash: resetHash,
        });
        if (resetReceipt.status !== "success") {
          throw new Error("The USDG allowance reset reverted.");
        }
      }
      if (plan.approveAfterReset) {
        await requireFreshWriteRuntime();
        const hash = await writeContractAsync({
          address: USDG_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [launcher, firstBuyAmount],
          chainId: ROBINHOOD_CHAIN_ID,
        });
        const approvalReceipt = await client.waitForTransactionReceipt({ hash });
        if (approvalReceipt.status !== "success") {
          throw new Error("The exact USDG approval reverted.");
        }
      }
      const verifiedAllowance = await refreshUsdgAllowance(launcher);
      if (verifiedAllowance !== firstBuyAmount) {
        throw new Error("USDG did not record the exact first-buy allowance.");
      }
      setApprovalNeededFingerprint("");
      setPhase("idle");
      await simulateExactLaunch();
    } catch (reason) {
      setError(readableError(reason));
      setPhase("idle");
      await refreshUsdgAllowance(launcher);
    }
  }

  async function revokeUsdgAllowance(allowance: SpenderAllowance) {
    if (
      !address ||
      !client ||
      !sameAddress(address, allowance.owner) ||
      allowance.amount <= 0n ||
      !spenderAllowance(usdgAllowances, address, allowance.spender) ||
      (phase !== "idle" && phase !== "ready")
    ) {
      return;
    }
    const revokesCurrentLauncher =
      launcher !== null && sameAddress(launcher, allowance.spender);
    setError("");
    setAllowanceActionSpender(allowance.spender);
    setPhase("approving");
    try {
      const hash = await writeContractAsync({
        address: USDG_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [allowance.spender, 0n],
        chainId: ROBINHOOD_CHAIN_ID,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error("The USDG allowance revocation reverted.");
      }
      const verifiedAllowance = await refreshUsdgAllowance(allowance.spender);
      if (verifiedAllowance !== 0n) {
        throw new Error("USDG allowance is still nonzero after revocation.");
      }
      if (revokesCurrentLauncher) {
        setSimulatedFingerprint("");
        if (pair.kind === "erc20" && firstBuyAmount > 0n) {
          setApprovalNeededFingerprint(exactFingerprint);
        } else {
          setApprovalNeededFingerprint("");
        }
      }
      setAllowanceActionSpender(null);
      setPhase("idle");
    } catch (reason) {
      setError(readableError(reason));
      setAllowanceActionSpender(null);
      setPhase("idle");
      await refreshUsdgAllowance(allowance.spender);
    }
  }

  async function simulateExactLaunch() {
    if (
      !address ||
      !launcher ||
      !client ||
      !launchParams ||
      !protocolTreasury ||
      validation.length > 0 ||
      !currentMined ||
      (phase !== "idle" && phase !== "ready")
    ) {
      return;
    }

    setError("");
    setPhase("simulating");
    try {
      await requireFreshWriteRuntime();
      if (!(await checkAllowance())) {
        setPhase("idle");
        return;
      }
      await client.simulateContract({
        account: address,
        address: launcher,
        abi: LAUNCHER_ABI,
        functionName: "launch",
        args: [launchParams],
        value: pair.kind === "native" ? firstBuyAmount : 0n,
      });
      setSimulatedFingerprint(exactFingerprint);
      setPhase("ready");
    } catch (reason) {
      setSimulatedFingerprint("");
      const saltInvalid = invalidateRecoverableSalt(reason);
      setError(
        saltInvalid
          ? `${readableError(reason)} The invalid salt was discarded; ZapPad is searching for a fresh address.`
          : readableError(reason),
      );
      setPhase("idle");
    }
  }

  async function launch() {
    if (
      !address ||
      !launcher ||
      !client ||
      !launchParams ||
      !protocolTreasury ||
      !currentMined ||
      !simulationFresh ||
      phase !== "ready"
    ) {
      return;
    }
    const predictedToken = currentMined.token;
    setError("");
    setPhase("submitting");
    try {
      await requireFreshWriteRuntime();
      await requireExactUsdgAllowanceForLaunch();
      const simulation = await client.simulateContract({
        account: address,
        address: launcher,
        abi: LAUNCHER_ABI,
        functionName: "launch",
        args: [launchParams],
        value: pair.kind === "native" ? firstBuyAmount : 0n,
      });
      await requireFreshWriteRuntime();
      await requireExactUsdgAllowanceForLaunch();
      const hash = await writeContractAsync({
        ...simulation.request,
        chainId: ROBINHOOD_CHAIN_ID,
      });
      setTxHash(hash);
      setPhase("confirming");
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      if (receipt.status !== "success") {
        throw new Error("The launch transaction reverted. No token was created.");
      }

      let launchedEvent:
        | {
            token: Address;
            creator: Address;
            feeVault: Address;
            pool: Address;
            name: string;
            symbol: string;
            metadataURI: string;
            positionId: bigint;
            pairedAsset: Address;
            feeTier: number;
            floorTick: number;
          }
        | undefined;
      let provenanceEvent:
        | {
            token: Address;
            configHash: Hex;
            launchedAt: bigint;
            firstBuyAmountIn: bigint;
            firstBuyAmountOut: bigint;
          }
        | undefined;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== launcher.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: LAUNCHER_ABI,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "TokenLaunched") {
            launchedEvent = decoded.args;
          }
          if (decoded.eventName === "LaunchProvenanceRecorded") {
            provenanceEvent = decoded.args;
          }
        } catch {
          // Unrelated launcher log.
        }
      }
      if (!launchedEvent) {
        throw new Error("Launch receipt did not contain a TokenLaunched event.");
      }
      if (!provenanceEvent) {
        throw new Error(
          "Launch receipt did not contain a LaunchProvenanceRecorded event.",
        );
      }
      if (
        launchedEvent.token.toLowerCase() !== predictedToken.toLowerCase() ||
        launchedEvent.creator.toLowerCase() !== address.toLowerCase() ||
        launchedEvent.name !== launchParams.name ||
        launchedEvent.symbol !== launchParams.symbol ||
        launchedEvent.metadataURI !== launchParams.metadataURI ||
        launchedEvent.pairedAsset.toLowerCase() !==
          launchParams.pairedAsset.toLowerCase() ||
        launchedEvent.feeTier !== launchParams.feeTier ||
        launchedEvent.floorTick !== floorTick
      ) {
        throw new Error("TokenLaunched event did not match the signed launch.");
      }

      const nativeValue = pair.kind === "native" ? firstBuyAmount : 0n;
      const [launchReadback, expectedConfigHash, provenanceReadback, launchBlock] =
        await Promise.all([
          client.readContract({
            address: launcher,
            abi: LAUNCHER_ABI,
            functionName: "launches",
            args: [launchedEvent.token],
            blockNumber: receipt.blockNumber,
          }),
          client.readContract({
            address: launcher,
            abi: LAUNCHER_ABI,
            functionName: "launchConfigHash",
            args: [address, launchParams, nativeValue],
            blockNumber: receipt.blockNumber,
          }),
          client.readContract({
            address: launcher,
            abi: LAUNCHER_ABI,
            functionName: "launchProvenance",
            args: [launchedEvent.token],
            blockNumber: receipt.blockNumber,
          }),
          client.getBlock({ blockNumber: receipt.blockNumber }),
        ]);
      const [
        exists,
        recordedCreator,
        recordedPool,
        recordedVault,
        recordedPositionId,
        recordedPair,
        recordedFeeTier,
        recordedFloorTick,
      ] = launchReadback;
      if (
        !exists ||
        recordedCreator.toLowerCase() !== launchedEvent.creator.toLowerCase() ||
        recordedPool.toLowerCase() !== launchedEvent.pool.toLowerCase() ||
        recordedVault.toLowerCase() !== launchedEvent.feeVault.toLowerCase() ||
        recordedPositionId !== launchedEvent.positionId ||
        recordedPair.toLowerCase() !== launchedEvent.pairedAsset.toLowerCase() ||
        recordedFeeTier !== launchedEvent.feeTier ||
        recordedFloorTick !== launchedEvent.floorTick
      ) {
        throw new Error("Confirmed launch state did not match its receipt.");
      }
      const [
        recordedConfigHash,
        launchedAt,
        firstBuyAmountIn,
        firstBuyAmountOut,
      ] = provenanceReadback;
      const expectedFirstBuyIn = firstBuyAmount;
      if (
        !launchBlock.hash ||
        launchBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
      ) {
        throw new Error(
          "The launch block changed before its exact-block state could be verified.",
        );
      }
      if (
        provenanceEvent.token.toLowerCase() !==
          launchedEvent.token.toLowerCase() ||
        provenanceEvent.configHash !== expectedConfigHash ||
        provenanceEvent.configHash !== recordedConfigHash ||
        provenanceEvent.launchedAt !== launchedAt ||
        provenanceEvent.firstBuyAmountIn !== firstBuyAmountIn ||
        provenanceEvent.firstBuyAmountOut !== firstBuyAmountOut ||
        launchedAt !== launchBlock.timestamp ||
        firstBuyAmountIn !== expectedFirstBuyIn ||
        (expectedFirstBuyIn === 0n
          ? firstBuyAmountOut !== 0n
          : firstBuyAmountOut < launchParams.minFirstBuyTokensOut)
      ) {
        throw new Error(
          "Confirmed launch provenance did not match the signed configuration.",
        );
      }
      setResult({
        token: launchedEvent.token,
        creator: launchedEvent.creator,
        protocolTreasury,
        feeVault: launchedEvent.feeVault,
        pool: launchedEvent.pool,
        positionId: launchedEvent.positionId,
        pairedAsset: launchedEvent.pairedAsset,
        feeTier: launchedEvent.feeTier,
        floorTick: launchedEvent.floorTick,
        name: launchedEvent.name,
        symbol: launchedEvent.symbol,
        metadataURI: launchedEvent.metadataURI,
        salt: launchParams.salt,
        firstBuyPairIn: launchParams.firstBuyPairIn,
        minFirstBuyTokensOut: launchParams.minFirstBuyTokensOut,
        nativeValue,
        configHash: recordedConfigHash,
        launchedAt,
        firstBuyAmountIn,
        firstBuyAmountOut,
        hash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
      });
      if (pair.kind === "erc20") {
        setUsdgAllowances((current) =>
          recordSpenderAllowance(current, address, launcher, 0n),
        );
      }
      setPhase("success");
    } catch (reason) {
      const saltInvalid = invalidateRecoverableSalt(reason);
      setError(
        saltInvalid
          ? `${readableError(reason)} The invalid salt was discarded; ZapPad is searching for a fresh address.`
          : readableError(reason),
      );
      setPhase("idle");
      if (pair.kind === "erc20") await refreshUsdgAllowance(launcher);
    }
  }

  function invalidateRecoverableSalt(reason: unknown) {
    if (!isRecoverableLaunchSaltError(reason)) return false;
    miningRun.current += 1;
    miningKey.current = "";
    setMined(null);
    setSimulatedFingerprint("");
    setApprovalNeededFingerprint("");
    return true;
  }

  function changePair(next: Address) {
    const meta =
      PAIR_ASSETS.find(
        (candidate) => candidate.address.toLowerCase() === next.toLowerCase(),
      ) ?? PAIR_ASSETS[0];
    setPairedAsset(next);
    setMarketCap(String(meta.marketCapPresets[1]));
    setFirstBuy("");
    setMinimumTokens("");
  }

  function reset() {
    miningRun.current += 1;
    miningKey.current = "";
    setName("");
    setSymbol("");
    setMetadataURI("");
    setPairedAsset(WETH_ADDRESS);
    setFeeTier(10_000);
    setMarketCap("5");
    setFirstBuy("");
    setMinimumTokens("");
    setMined(null);
    setSimulatedFingerprint("");
    setApprovalNeededFingerprint("");
    setAllowanceActionSpender(null);
    setError("");
    setTxHash(null);
    setResult(null);
    setPhase("idle");
  }

  function downloadLaunchReceipt() {
    if (!result || !launcher) return;
    const payload = {
      schema: "zappad-launch-receipt/v1",
      chainId: ROBINHOOD_CHAIN_ID,
      launcher,
      transactionHash: result.hash,
      blockHash: result.blockHash,
      blockNumber: result.blockNumber,
      creator: result.creator,
      protocolTreasury: result.protocolTreasury,
      token: result.token,
      feeVault: result.feeVault,
      pool: result.pool,
      positionId: result.positionId,
      launch: {
        name: result.name,
        symbol: result.symbol,
        metadataURI: result.metadataURI,
        salt: result.salt,
        floorTick: result.floorTick,
        pairedAsset: result.pairedAsset,
        feeTier: result.feeTier,
        firstBuyPairIn: result.firstBuyPairIn,
        minFirstBuyTokensOut: result.minFirstBuyTokensOut,
        nativeValue: result.nativeValue,
      },
      provenance: {
        configHash: result.configHash,
        launchedAt: result.launchedAt,
        firstBuyAmountIn: result.firstBuyAmountIn,
        firstBuyAmountOut: result.firstBuyAmountOut,
      },
      verification:
        "Decoded receipt events and exact-block launcher readbacks matched the signed launch.",
    };
    const json = JSON.stringify(
      payload,
      (_, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    );
    const url = URL.createObjectURL(
      new Blob([`${json}\n`], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `zappad-${result.symbol.toLowerCase()}-${result.token.slice(2, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (result) {
    return (
      <section
        aria-live="polite"
        className="launch-success"
        role="status"
      >
        <div className="success-burst" aria-hidden="true">
          Z
        </div>
        <div className="eyebrow">Launch included</div>
        <h2>
          {name} <span>${normalizedSymbol}</span> is live.
        </h2>
        <p>
          The transaction was included in a Robinhood Chain block, and its
          events, launch record, and provenance commitment matched the signed
          configuration. Network finality continues after inclusion.
        </p>
        <div className="success-addresses">
          <a href={explorerAddress(result.token)} rel="noreferrer" target="_blank">
            <span>Token</span>
            <strong>{result.token}</strong>
          </a>
          <a
            href={explorerAddress(result.feeVault)}
            rel="noreferrer"
            target="_blank"
          >
            <span>Fee vault</span>
            <strong>{result.feeVault}</strong>
          </a>
          <a href={explorerTransaction(result.hash)} rel="noreferrer" target="_blank">
            <span>Transaction</span>
            <strong>{shortAddress(result.hash, 10, 8)}</strong>
          </a>
        </div>
        <div className="hero-actions">
          <Link
            className="button button-primary"
            href={`/launch/token/${result.token}`}
          >
            Open token console
          </Link>
          <button
            className="button button-secondary"
            onClick={downloadLaunchReceipt}
            type="button"
          >
            Download receipt
          </button>
          <button className="button button-secondary" onClick={reset} type="button">
            Launch another
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-busy={[
        "mining",
        "approving",
        "simulating",
        "submitting",
        "confirming",
      ].includes(phase)}
      className="studio-shell"
    >
      <div className="studio-progress">
        <div className="studio-step active">
          <span>1</span>
          <div>
            <strong>Identity</strong>
            <small>Name and metadata</small>
          </div>
        </div>
        <div className={`studio-step ${name && normalizedSymbol ? "active" : ""}`}>
          <span>2</span>
          <div>
            <strong>Market</strong>
            <small>Pool and price</small>
          </div>
        </div>
        <div className={`studio-step ${currentMined ? "active" : ""}`}>
          <span>3</span>
          <div>
            <strong>Pre-flight</strong>
            <small>Predict and simulate</small>
          </div>
        </div>
      </div>

      <div className="studio-grid">
        <div className="studio-form">
          <section className="form-section">
            <div className="form-heading">
              <span>01</span>
              <div>
                <h2>Token identity</h2>
                <p>A fixed 1 billion supply with standard ERC-20 transfers.</p>
              </div>
            </div>
            <div className="field-grid two-columns">
              <label className="field">
                <span>Token name</span>
                <input
                  autoComplete="off"
                  maxLength={48}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Zap Culture"
                  value={name}
                />
              </label>
              <label className="field">
                <span>Symbol</span>
                <div className="input-prefix">
                  <b>$</b>
                  <input
                    autoCapitalize="characters"
                    autoComplete="off"
                    maxLength={12}
                    onChange={(event) =>
                      setSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
                    }
                    placeholder="ZAP"
                    value={symbol}
                  />
                </div>
              </label>
            </div>
            <label className="field">
              <span>
                Metadata URI
                <small>Permanent https, IPFS or Arweave metadata</small>
              </span>
              <input
                autoComplete="off"
                onChange={(event) => setMetadataURI(event.target.value)}
                placeholder="ipfs://bafy…/metadata.json"
                value={metadataURI}
              />
            </label>
          </section>

          <section className="form-section">
            <div className="form-heading">
              <span>02</span>
              <div>
                <h2>Opening market</h2>
                <p>Choose the quote asset and initial single-sided v3 range.</p>
              </div>
            </div>
            <div className="field">
              <span>Paired asset</span>
              <div className="choice-grid pair-choices">
                {PAIR_ASSETS.map((asset) => (
                  <button
                    aria-pressed={
                      pairedAsset.toLowerCase() === asset.address.toLowerCase()
                    }
                    className={
                      pairedAsset.toLowerCase() === asset.address.toLowerCase()
                        ? "choice-card active"
                        : "choice-card"
                    }
                    key={asset.address}
                    onClick={() => changePair(asset.address)}
                    type="button"
                  >
                    <span className={`asset-icon asset-${asset.kind}`}>
                      {asset.displaySymbol.slice(0, 1)}
                    </span>
                    <span>
                      <strong>{asset.displaySymbol}</strong>
                      <small>{asset.symbol}</small>
                    </span>
                    <i aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
            <div className="field-grid two-columns">
              <label className="field">
                <span>
                  Opening market cap
                  <small>In {pair.displaySymbol}</small>
                </span>
                <div className="input-suffix">
                  <input
                    inputMode="decimal"
                    min="0"
                    onChange={(event) => setMarketCap(event.target.value)}
                    step="any"
                    type="number"
                    value={marketCap}
                  />
                  <b>{pair.displaySymbol}</b>
                </div>
                <div className="preset-row">
                  {pair.marketCapPresets.map((preset) => (
                    <button
                      aria-pressed={marketCap === String(preset)}
                      key={preset}
                      onClick={() => setMarketCap(String(preset))}
                      type="button"
                    >
                      {preset.toLocaleString()}
                    </button>
                  ))}
                </div>
              </label>
              <div className="field">
                <span>Uniswap v3 fee tier</span>
                <div className="tier-grid">
                  {FEE_TIERS.map((tier) => (
                    <button
                      aria-pressed={feeTier === tier.fee}
                      className={feeTier === tier.fee ? "active" : ""}
                      key={tier.fee}
                      onClick={() => setFeeTier(tier.fee)}
                      type="button"
                    >
                      <strong>{tier.label}</strong>
                      <small>{tier.hint}</small>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="field-grid two-columns">
              <label className="field">
                <span>
                  Optional first buy
                  <small>Atomic with launch</small>
                </span>
                <div className="input-suffix">
                  <input
                    inputMode="decimal"
                    min="0"
                    onChange={(event) => setFirstBuy(event.target.value)}
                    placeholder="0"
                    step="any"
                    type="number"
                    value={firstBuy}
                  />
                  <b>{pair.displaySymbol}</b>
                </div>
              </label>
              <label className="field">
                <span>
                  Minimum tokens out
                  <small>Required when first buy is set</small>
                </span>
                <div className="input-suffix">
                  <input
                    inputMode="decimal"
                    min="0"
                    onChange={(event) => setMinimumTokens(event.target.value)}
                    placeholder="0"
                    step="any"
                    type="number"
                    value={minimumTokens}
                  />
                  <b>{normalizedSymbol || "TOKEN"}</b>
                </div>
              </label>
            </div>
          </section>
        </div>

        <aside className="review-card">
          <div className="review-topline">
            <span>Launch pre-flight</span>
            <span className={launcher ? "online" : "offline"}>
              {launcher
                ? "Writes enabled"
                : config?.readEnabled
                  ? "Writes paused"
                  : "Unavailable"}
            </span>
          </div>

          <div className="review-token">
            <div className="token-placeholder">{normalizedSymbol.slice(0, 1) || "?"}</div>
            <div>
              <strong>{name.trim() || "Untitled token"}</strong>
              <span>${normalizedSymbol || "TOKEN"}</span>
            </div>
          </div>

          <dl className="review-list">
            <div>
              <dt>Total supply</dt>
              <dd>1,000,000,000</dd>
            </div>
            <div>
              <dt>Pair</dt>
              <dd>{normalizedSymbol || "TOKEN"} / {pair.displaySymbol}</dd>
            </div>
            <div>
              <dt>Fee tier</dt>
              <dd>{FEE_TIERS.find((tier) => tier.fee === feeTier)?.label}</dd>
            </div>
            <div>
              <dt>First buy</dt>
              <dd>
                {firstBuyAmount > 0n
                  ? `${firstBuy.trim()} ${pair.displaySymbol}`
                  : "None"}
              </dd>
            </div>
            <div>
              <dt>Minimum output</dt>
              <dd>
                {minimumTokensOut > 0n
                  ? `${minimumTokens.trim()} ${normalizedSymbol || "TOKEN"}`
                  : "None"}
              </dd>
            </div>
            <div>
              <dt>Fee shares</dt>
              <dd>80 creator / 20 treasury</dd>
            </div>
            <div>
              <dt>Treasury recipient</dt>
              <dd>
                {protocolTreasury ? (
                  <a
                    href={explorerAddress(protocolTreasury)}
                    rel="noreferrer"
                    target="_blank"
                    title={protocolTreasury}
                  >
                    {shortAddress(protocolTreasury)}
                  </a>
                ) : (
                  launcher && !treasuryError ? "Reading onchain…" : "Unavailable"
                )}
              </dd>
            </div>
            <div>
              <dt>Floor tick</dt>
              <dd>{floorTick.toLocaleString()}</dd>
            </div>
            <div>
              <dt>LP position</dt>
              <dd className="positive">Locked</dd>
            </div>
            <div>
              <dt>Transfer tax</dt>
              <dd>None</dd>
            </div>
          </dl>

          <div className="prediction-box">
            <span>CREATE2 token address</span>
            {phase === "mining" ? (
              <strong className="working">
                <i /> Searching below {shortAddress(pairedAsset)}…
              </strong>
            ) : currentMined ? (
              <>
                <strong>{currentMined.token}</strong>
                <small>
                  Verified token0 ordering · {currentMined.attempts} prediction
                  {currentMined.attempts === 1 ? "" : "s"}
                </small>
              </>
            ) : (
              <strong>Waiting for valid identity…</strong>
            )}
          </div>

          {validation.length > 0 && (
            <div aria-live="polite" className="validation-list">
              {validation.map((issue) => (
                <span key={issue}>{issue}</span>
              ))}
            </div>
          )}

          {configError && (
            <div className="notice notice-danger" role="alert">
              {configError}
            </div>
          )}
          {treasuryError && (
            <div className="notice notice-danger" role="alert">
              {treasuryError}
            </div>
          )}
          {!configLoading && !launcher && (
            <div className="notice notice-warning" role="status">
              {config?.readEnabled
                ? "The launcher is verified for reads, but new launches and approvals are not activated. Any existing USDG allowance remains revocable."
                : "The launcher has not passed runtime verification. Launches and approvals are disabled; a previously verified USDG allowance remains revocable."}
            </div>
          )}
          {error && (
            <div className="notice notice-danger" role="alert">
              {error}
            </div>
          )}
          {txHash && phase === "confirming" && (
            <a
              className="notice notice-info"
              href={explorerTransaction(txHash)}
              aria-live="polite"
              rel="noreferrer"
              target="_blank"
            >
              Transaction submitted. Waiting for a confirmed receipt ↗
            </a>
          )}
          {simulationFresh && (
            <div className="simulation-pass" role="status">
              <span>✓</span>
              <div>
                <strong>Exact call simulated</strong>
                <small>Inputs have not changed since simulation.</small>
              </div>
            </div>
          )}

          <div className="review-actions">
            {configLoading ? (
              <button
                className="button button-primary button-full"
                disabled
                type="button"
              >
                Verifying launch runtime…
              </button>
            ) : !launcher ? (
              <button
                className="button button-primary button-full"
                disabled
                type="button"
              >
                {config?.readEnabled
                  ? "Launch writes paused"
                  : "Launch runtime unavailable"}
              </button>
            ) : !isConnected ? (
              <button
                className="button button-primary button-full"
                disabled={connecting}
                onClick={connectWallet}
                type="button"
              >
                {connecting ? "Connecting…" : "Connect wallet"}
              </button>
            ) : wrongChain ? (
              <button
                className="button button-warning button-full"
                disabled={switching}
                onClick={switchNetwork}
                type="button"
              >
                {switching ? "Switching…" : "Switch to Robinhood Chain"}
              </button>
            ) : needsApproval ? (
              <button
                className="button button-primary button-full"
                disabled={phase !== "idle" && phase !== "ready"}
                onClick={approveExactFirstBuy}
                type="button"
              >
                {phase === "approving"
                  ? "Approving exact USDG amount…"
                  : "Approve exact first buy"}
              </button>
            ) : !simulationFresh ? (
              <button
                className="button button-primary button-full"
                disabled={
                  !inputReady ||
                  (phase !== "idle" && phase !== "ready") ||
                  configLoading
                }
                onClick={simulateExactLaunch}
                type="button"
              >
                {phase === "simulating" ? "Simulating exact call…" : "Run exact simulation"}
              </button>
            ) : (
              <button
                className="button button-primary button-full launch-button"
                disabled={phase === "submitting" || phase === "confirming"}
                onClick={launch}
                type="button"
              >
                {phase === "submitting"
                  ? "Confirm in wallet…"
                  : phase === "confirming"
                    ? "Confirming onchain…"
                    : "Launch on Robinhood Chain ↗"}
              </button>
            )}
            {phase !== "mining" && address && launcher && !currentMined && (
              <button
                className="button button-quiet button-full"
                disabled={
                  phase === "approving" ||
                  phase === "submitting" ||
                  phase === "confirming"
                }
                onClick={mineIdentity}
                type="button"
              >
                Retry address search
              </button>
            )}
            {address &&
              currentOwnerAllowances.map((allowance) => (
                <button
                  className="button button-quiet button-full"
                  disabled={phase !== "idle" && phase !== "ready"}
                  key={allowanceAuthorityKey(
                    allowance.owner,
                    allowance.spender,
                  )}
                  onClick={() => revokeUsdgAllowance(allowance)}
                  type="button"
                  title={allowance.spender}
                >
                  {phase === "approving" &&
                  allowanceActionSpender &&
                  sameAddress(allowanceActionSpender, allowance.spender)
                    ? `Revoking allowance to ${shortAddress(allowance.spender)}…`
                    : activeAllowanceSpender &&
                        sameAddress(activeAllowanceSpender, allowance.spender)
                      ? `Revoke ${formatUnits(allowance.amount, 6)} USDG allowance to ${shortAddress(allowance.spender)}`
                      : `Revoke prior allowance to ${shortAddress(allowance.spender)} · last verified ${formatUnits(allowance.amount, 6)} USDG`}
                </button>
              ))}
          </div>

          <p className="review-disclaimer">
            The interface simulates the exact launch immediately before signing.
            Always verify wallet calldata and value. ZapPad is not audited.
          </p>
        </aside>
      </div>
    </section>
  );
}
