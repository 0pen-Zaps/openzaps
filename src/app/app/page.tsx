"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodePacked,
  formatUnits,
  getAddress,
  http,
  keccak256,
  maxUint256,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { OpenZapMark } from "@/components/OpenZapMark";
import { trackEvent } from "@/lib/analytics";
import {
  OPENZAP_CONTRACTS,
  ROBINHOOD_ASSETS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_LIQUIDITY,
  ROBINHOOD_RPC_URL,
  erc20Abi,
  explorerAddress,
  explorerTransaction,
  getInjectedProvider,
  openZapAbi,
  openZapFactoryAbi,
  openZapProtocolConfigured,
  robinhoodChain,
  robinhoodPoolKey,
  v4QuoterAbi,
  wethAbi,
} from "@/lib/robinhood";
import styles from "./app.module.css";

type Direction = "buy" | "sell";
type BusyAction = "connect" | "quote" | "create" | "wrap" | "fund" | "execute" | "recover" | "load" | null;

type ZapRecord = {
  zapAddress: Address;
  direction: Direction;
  amountIn: string;
  createTx?: Hex;
  createdAt: string;
};

type TransactionRecord = {
  hash: Hex;
  label: string;
  status: "confirmed" | "failed";
};

const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
const STORAGE_KEY = "openzaps:robinhood-live-zap:v1";

export default function AppPage(): React.JSX.Element {
  const configured = openZapProtocolConfigured();
  const [account, setAccount] = useState<Address | null>(null);
  const [direction, setDirection] = useState<Direction>("buy");
  const [amount, setAmount] = useState("0.001");
  const [slippageBps, setSlippageBps] = useState(100);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoteGas, setQuoteGas] = useState<bigint | null>(null);
  const [zap, setZap] = useState<ZapRecord | null>(null);
  const [manualZap, setManualZap] = useState("");
  const [walletInputBalance, setWalletInputBalance] = useState(0n);
  const [walletOutputBalance, setWalletOutputBalance] = useState(0n);
  const [zapInputBalance, setZapInputBalance] = useState(0n);
  const [nativeBalance, setNativeBalance] = useState(0n);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);

  const tokenIn = direction === "buy" ? ROBINHOOD_ASSETS.weth : ROBINHOOD_ASSETS.zaps;
  const tokenOut = direction === "buy" ? ROBINHOOD_ASSETS.zaps : ROBINHOOD_ASSETS.weth;
  const inputSymbol = direction === "buy" ? "aeWETH" : "0xZAPS";
  const outputSymbol = direction === "buy" ? "0xZAPS" : "aeWETH";
  const amountIn = useMemo(() => parseAmount(amount), [amount]);
  const requiredAmount = zap ? BigInt(zap.amountIn) : amountIn;
  const funded = zap !== null && requiredAmount > 0n && zapInputBalance >= requiredAmount;
  const minOut = quote === null ? null : (quote * BigInt(10_000 - slippageBps)) / 10_000n;

  const refreshBalances = useCallback(async (): Promise<void> => {
    if (!account) return;
    try {
      const [input, output, native, zapBalance] = await Promise.all([
        publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        publicClient.getBalance({ address: account }),
        zap
          ? publicClient.readContract({
              address: tokenIn,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [zap.zapAddress],
            })
          : Promise.resolve(0n),
      ]);
      setWalletInputBalance(input);
      setWalletOutputBalance(output);
      setNativeBalance(native);
      setZapInputBalance(zapBalance);
    } catch (cause) {
      setError(readableError(cause));
    }
  }, [account, tokenIn, tokenOut, zap]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refreshBalances();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshBalances]);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const raw = window.localStorage.getItem(`${STORAGE_KEY}:${account.toLowerCase()}`);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as ZapRecord;
        if (parsed.zapAddress && parsed.amountIn) {
          setZap({ ...parsed, zapAddress: getAddress(parsed.zapAddress) });
          setDirection(parsed.direction);
          setAmount(formatUnits(BigInt(parsed.amountIn), 18));
        }
      } catch {
        window.localStorage.removeItem(`${STORAGE_KEY}:${account.toLowerCase()}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [account]);

  async function connectWallet(): Promise<void> {
    setBusy("connect");
    clearMessages();
    try {
      const provider = getInjectedProvider();
      if (!provider) throw new Error("No injected wallet found. Install or open MetaMask, Rabby, or another EIP-1193 wallet.");
      await ensureRobinhoodChain(provider);
      const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(provider) });
      const addresses = await wallet.requestAddresses();
      if (!addresses[0]) throw new Error("The wallet did not return an account.");
      const nextAccount = getAddress(addresses[0]);
      setAccount(nextAccount);
      setNotice("Wallet connected to Robinhood Chain.");
      trackEvent("robinhood_wallet_connected", { account: nextAccount });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function requestQuote(): Promise<bigint | null> {
    setBusy("quote");
    clearMessages();
    try {
      if (amountIn <= 0n) throw new Error("Enter an amount greater than zero.");
      if (amountIn > 2n ** 128n - 1n) throw new Error("Amount exceeds the Robinhood v4 router limit.");
      const { result } = await publicClient.simulateContract({
        account: account ?? zeroAddress,
        address: ROBINHOOD_LIQUIDITY.v4Quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: robinhoodPoolKey,
            zeroForOne: direction === "buy",
            exactAmount: amountIn,
            hookData: "0x",
          },
        ],
      });
      setQuote(result[0]);
      setQuoteGas(result[1]);
      setNotice("Live pool quote loaded. The signed minimum is enforced after the adapter returns.");
      return result[0];
    } catch (cause) {
      setQuote(null);
      setQuoteGas(null);
      setError(`Quote unavailable: ${readableError(cause)}`);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createZap(): Promise<void> {
    setBusy("create");
    clearMessages();
    try {
      const owner = requireAccount(account);
      requireConfigured(configured);
      if (amountIn <= 0n) throw new Error("Enter an amount greater than zero.");
      await ensureActiveChain();

      const policy = buildPolicy(owner, direction, amountIn);
      const timestamp = currentTimestampMs();
      const salt = keccak256(
        encodePacked(["address", "uint256", "uint256"], [owner, timestamp, amountIn]),
      );
      const predicted = await publicClient.readContract({
        address: OPENZAP_CONTRACTS.factory,
        abi: openZapFactoryAbi,
        functionName: "predict",
        args: [policy, salt],
      });
      const wallet = requireWallet();
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: OPENZAP_CONTRACTS.factory,
        abi: openZapFactoryAbi,
        functionName: "createZap",
        args: [policy, salt],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(hash, "Create immutable zap", receipt.status);
      if (receipt.status !== "success") throw new Error("Factory transaction reverted.");

      const [code, deployedOwner] = await Promise.all([
        publicClient.getCode({ address: predicted }),
        publicClient.readContract({ address: predicted, abi: openZapAbi, functionName: "owner" }),
      ]);
      if (!code || code === "0x") throw new Error("Predicted zap address has no deployed bytecode.");
      if (deployedOwner.toLowerCase() !== owner.toLowerCase()) throw new Error("Deployed zap owner does not match the wallet.");

      const nextZap: ZapRecord = {
        zapAddress: predicted,
        direction,
        amountIn: amountIn.toString(),
        createTx: hash,
        createdAt: new Date().toISOString(),
      };
      saveZap(owner, nextZap);
      setZap(nextZap);
      setNotice(`Immutable zap created at ${shortAddress(predicted)}. Fund it before execution.`);
      trackEvent("robinhood_zap_created", { zap: predicted, direction });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function wrapEth(): Promise<void> {
    setBusy("wrap");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (amountIn <= 0n) throw new Error("Enter an amount greater than zero.");
      await ensureActiveChain();
      const wallet = requireWallet();
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: ROBINHOOD_ASSETS.weth,
        abi: wethAbi,
        functionName: "deposit",
        value: amountIn,
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(hash, "Wrap ETH to aeWETH", receipt.status);
      if (receipt.status !== "success") throw new Error("WETH deposit reverted.");
      setNotice(`Wrapped ${formatToken(amountIn)} ETH into aeWETH.`);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function fundZap(): Promise<void> {
    setBusy("fund");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a zap first.");
      await ensureActiveChain();
      const current = await publicClient.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [zap.zapAddress],
      });
      const target = BigInt(zap.amountIn);
      if (current >= target) {
        setNotice("Zap is already funded for this execution.");
        return;
      }
      const missing = target - current;
      const balance = await publicClient.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      });
      if (balance < missing) throw new Error(`Insufficient ${inputSymbol}. ${formatToken(missing)} required.`);
      const wallet = requireWallet();
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: tokenIn,
        abi: erc20Abi,
        functionName: "transfer",
        args: [zap.zapAddress, missing],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(hash, `Fund zap with ${inputSymbol}`, receipt.status);
      if (receipt.status !== "success") throw new Error("Funding transfer reverted.");
      const verified = await publicClient.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [zap.zapAddress],
      });
      if (verified < target) throw new Error("Zap balance did not reach the policy amount after confirmation.");
      setNotice(`Zap funded with ${formatToken(target)} ${inputSymbol}.`);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function executeZap(): Promise<void> {
    setBusy("execute");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a zap first.");
      if (!funded) throw new Error("Fund the zap before execution.");
      await ensureActiveChain();

      const freshQuote = await quoteExactInput(direction, BigInt(zap.amountIn), owner);
      const signedMinOut = (freshQuote * BigInt(10_000 - slippageBps)) / 10_000n;
      if (signedMinOut <= 0n) throw new Error("The live quote is too small for a safe minimum output.");
      setQuote(freshQuote);

      const policyHash = await publicClient.readContract({
        address: zap.zapAddress,
        abi: openZapAbi,
        functionName: "policyHash",
      });
      const timestamp = currentTimestampMs();
      const now = Number(timestamp / 1_000n);
      const nonce = BigInt(
        keccak256(encodePacked(["address", "uint256", "uint256"], [owner, timestamp, freshQuote])),
      );
      const intent = {
        zap: zap.zapAddress,
        chainId: BigInt(ROBINHOOD_CHAIN_ID),
        nonce,
        validAfter: BigInt(Math.max(0, now - 5)),
        deadline: BigInt(now + 10 * 60),
        recipient: owner,
        relayer: zeroAddress,
        maxRelayerFee: 0n,
        maxGas: maxUint256,
        maxFeePerGas: maxUint256,
        policyHash,
        outAsset: tokenOut,
        minOut: signedMinOut,
      } as const;

      const wallet = requireWallet();
      const signature = await wallet.signTypedData({
        account: owner,
        domain: { name: "OpenZap", version: "1", chainId: ROBINHOOD_CHAIN_ID, verifyingContract: zap.zapAddress },
        primaryType: "OpenZapIntent",
        types: {
          OpenZapIntent: [
            { name: "zap", type: "address" },
            { name: "chainId", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "validAfter", type: "uint64" },
            { name: "deadline", type: "uint64" },
            { name: "recipient", type: "address" },
            { name: "relayer", type: "address" },
            { name: "maxRelayerFee", type: "uint256" },
            { name: "maxGas", type: "uint256" },
            { name: "maxFeePerGas", type: "uint256" },
            { name: "policyHash", type: "bytes32" },
            { name: "outAsset", type: "address" },
            { name: "minOut", type: "uint256" },
          ],
        },
        message: intent,
      });

      const outputBefore = await publicClient.readContract({
        address: tokenOut,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      });
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: zap.zapAddress,
        abi: openZapAbi,
        functionName: "execute",
        args: [intent, signature],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(hash, `${inputSymbol} → ${outputSymbol} zap`, receipt.status);
      if (receipt.status !== "success") throw new Error("Zap execution reverted.");

      const [outputAfter, nonceUsed] = await Promise.all([
        publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
        publicClient.readContract({ address: zap.zapAddress, abi: openZapAbi, functionName: "nonceUsed", args: [nonce] }),
      ]);
      if (!nonceUsed || outputAfter <= outputBefore) throw new Error("Receipt confirmed but output or nonce verification failed.");
      const received = outputAfter - outputBefore;
      setNotice(`Zap executed: received ${formatToken(received)} ${outputSymbol}.`);
      trackEvent("robinhood_zap_executed", { zap: zap.zapAddress, direction, tx: hash });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function recoverFunds(): Promise<void> {
    setBusy("recover");
    clearMessages();
    try {
      const owner = requireAccount(account);
      if (!zap) throw new Error("Create or load a zap first.");
      await ensureActiveChain();
      const wallet = requireWallet();
      const { request } = await publicClient.simulateContract({
        account: owner,
        address: zap.zapAddress,
        abi: openZapAbi,
        functionName: "emergencyExit",
        args: [[ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps]],
      });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      recordTransaction(hash, "Emergency asset recovery", receipt.status);
      if (receipt.status !== "success") throw new Error("Recovery transaction reverted.");
      setNotice("Tracked aeWETH and 0xZAPS balances returned to the zap owner.");
      trackEvent("robinhood_zap_recovered", { zap: zap.zapAddress, tx: hash });
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
      await refreshBalances();
    }
  }

  async function loadExistingZap(): Promise<void> {
    setBusy("load");
    clearMessages();
    try {
      const owner = requireAccount(account);
      requireConfigured(configured);
      const address = getAddress(manualZap.trim());
      const [code, zapOwner, step] = await Promise.all([
        publicClient.getCode({ address }),
        publicClient.readContract({ address, abi: openZapAbi, functionName: "owner" }),
        publicClient.readContract({ address, abi: openZapAbi, functionName: "step", args: [0n] }),
      ]);
      if (!code || code === "0x") throw new Error("No zap bytecode exists at that address.");
      if (zapOwner.toLowerCase() !== owner.toLowerCase()) throw new Error("Connected wallet is not this zap's owner.");
      if (step.adapter.toLowerCase() !== OPENZAP_CONTRACTS.adapter.toLowerCase()) {
        throw new Error("Zap does not use the current verified Robinhood adapter.");
      }
      const loadedDirection: Direction = step.tokenIn.toLowerCase() === ROBINHOOD_ASSETS.weth.toLowerCase() ? "buy" : "sell";
      const record: ZapRecord = {
        zapAddress: address,
        direction: loadedDirection,
        amountIn: step.amountIn.toString(),
        createdAt: new Date().toISOString(),
      };
      saveZap(owner, record);
      setZap(record);
      setDirection(loadedDirection);
      setAmount(formatUnits(step.amountIn, 18));
      setNotice(`Loaded verified zap ${shortAddress(address)}.`);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }

  function disconnect(): void {
    setAccount(null);
    setZap(null);
    setQuote(null);
    setTransactions([]);
    clearMessages();
  }

  function recordTransaction(hash: Hex, label: string, status: "success" | "reverted"): void {
    setTransactions((current) => [
      { hash, label, status: status === "success" ? "confirmed" : "failed" },
      ...current,
    ]);
  }

  function clearMessages(): void {
    setNotice("");
    setError("");
  }

  function changeDirection(nextDirection: Direction): void {
    setDirection(nextDirection);
    setQuote(null);
    setQuoteGas(null);
  }

  function changeAmount(nextAmount: string): void {
    setAmount(nextAmount);
    setQuote(null);
    setQuoteGas(null);
  }

  const stepLabel = !account ? "1. Connect wallet" : !zap ? "2. Create zap" : !funded ? "3. Fund zap" : "4. Sign & execute";

  return (
    <main className={styles.page} id="main">
      <section className={`container ${styles.statusBar}`} aria-label="Protocol status">
        <span className={configured ? styles.statusLive : styles.statusPreview}>{configured ? "Live on Robinhood" : "Deploying"}</span>
        <p>
          {configured ? (
            <>
              Verified one-step WETH ↔ 0xZAPS policies through factory{" "}
              <a href={explorerAddress(OPENZAP_CONTRACTS.factory)} target="_blank" rel="noreferrer">
                {shortAddress(OPENZAP_CONTRACTS.factory)}
              </a>
              . Every execution enforces the wallet-signed minimum output.
            </>
          ) : (
            <>Robinhood contracts are not configured in this build. Wallet transactions are disabled.</>
          )}
        </p>
      </section>

      <section className={`container ${styles.appHead}`}>
        <div className={styles.titleRow}>
          <OpenZapMark className={styles.headMark} />
          <div>
            <span className="eyebrow">Live zap console</span>
            <h1>One policy. One bounded swap.</h1>
            <p>Create an immutable capsule, fund only its exact input, sign the output floor, and execute on Robinhood Chain.</p>
          </div>
        </div>
        <div className={styles.wallet}>
          {account ? (
            <>
              <a className={styles.addr} href={explorerAddress(account)} target="_blank" rel="noreferrer">
                {shortAddress(account)}
              </a>
              <button className="btn btnGhost" onClick={disconnect} type="button">Disconnect</button>
            </>
          ) : (
            <button className="btn btnPrimary" disabled={busy !== null} onClick={() => void connectWallet()} type="button">
              {busy === "connect" ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      </section>

      {notice && <div className={`container ${styles.notice}`} role="status">{notice}</div>}
      {error && <div className={`container ${styles.error}`} role="alert">{error}</div>}

      <section className={`container ${styles.metrics}`} aria-label="Live protocol metrics">
        <Metric label="Network" value="Robinhood 4663" />
        <Metric label="Pool" value="v4 · 2% hook" />
        <Metric label="Wallet input" value={`${formatToken(walletInputBalance)} ${inputSymbol}`} />
        <Metric label="Current step" value={stepLabel} />
      </section>

      <section className={`container ${styles.workspace}`}>
        <section className={styles.builder} aria-label="Build a live zap">
          <div className={styles.builderTop}>
            <div>
              <span className={styles.cardHead}>Policy builder</span>
              <h2>Fixed-input Robinhood swap</h2>
              <p>The adapter is pool-bound: it cannot route to another token, spender, hook, or DEX.</p>
            </div>
            <span className={styles.liveBadge}>onchain</span>
          </div>

          <div className={styles.segment}>
            <button className={direction === "buy" ? styles.segOn : styles.seg} onClick={() => changeDirection("buy")} disabled={zap !== null} type="button">
              Buy 0xZAPS <em>aeWETH → 0xZAPS</em>
            </button>
            <button className={direction === "sell" ? styles.segOn : styles.seg} onClick={() => changeDirection("sell")} disabled={zap !== null} type="button">
              Sell 0xZAPS <em>0xZAPS → aeWETH</em>
            </button>
          </div>

          <div className={styles.formGrid}>
            <Field label={`Exact input (${inputSymbol})`}>
              <input className={styles.input} inputMode="decimal" value={amount} onChange={(event) => changeAmount(sanitizeDecimal(event.target.value))} disabled={zap !== null} />
            </Field>
            <Field label={`Signed max slippage (${(slippageBps / 100).toFixed(2)}%)`}>
              <input className={styles.range} min="10" max="500" step="10" type="range" value={slippageBps} onChange={(event) => setSlippageBps(Number(event.target.value))} />
            </Field>
          </div>

          <div className={styles.quoteBox}>
            <div><span>Live quote</span><strong>{quote === null ? "Not requested" : `${formatToken(quote)} ${outputSymbol}`}</strong></div>
            <div><span>Signed minimum</span><strong>{minOut === null ? "—" : `${formatToken(minOut)} ${outputSymbol}`}</strong></div>
            <div><span>Quoter gas</span><strong>{quoteGas === null ? "—" : quoteGas.toLocaleString()}</strong></div>
            <button className="btn btnGhost" disabled={busy !== null || amountIn <= 0n} onClick={() => void requestQuote()} type="button">
              {busy === "quote" ? "Quoting…" : quote === null ? "Get live quote" : "Refresh quote"}
            </button>
          </div>

          <div className={styles.flow}>
            <FlowStep number="1" title="Create immutable zap" detail="Policy binds owner, recipient, adapter, spender, input token, and exact amount." done={zap !== null}>
              <button className="btn btnPrimary" disabled={!account || !configured || zap !== null || busy !== null || amountIn <= 0n} onClick={() => void createZap()} type="button">
                {busy === "create" ? "Creating…" : "Create zap"}
              </button>
            </FlowStep>
            <FlowStep number="2" title={`Fund with ${inputSymbol}`} detail="Direct ERC-20 transfer only. No standing wallet allowance is created." done={funded}>
              {direction === "buy" && (
                <button className="btn btnGhost" disabled={!account || busy !== null || amountIn <= 0n || nativeBalance < amountIn} onClick={() => void wrapEth()} type="button">
                  {busy === "wrap" ? "Wrapping…" : "Wrap ETH"}
                </button>
              )}
              <button className="btn btnPrimary" disabled={!zap || funded || busy !== null} onClick={() => void fundZap()} type="button">
                {busy === "fund" ? "Funding…" : "Fund zap"}
              </button>
            </FlowStep>
            <FlowStep number="3" title="Sign and execute" detail="A fresh v4 quote sets minOut; the EIP-712 intent expires in ten minutes." done={false}>
              <button className="btn btnPrimary" disabled={!funded || busy !== null} onClick={() => void executeZap()} type="button">
                {busy === "execute" ? "Executing…" : "Sign & execute"}
              </button>
            </FlowStep>
          </div>
        </section>

        <aside className={styles.review} aria-label="Live verification">
          <span className={styles.cardHead}>Verification</span>
          <h2>Nothing hidden.</h2>
          <div className={styles.verifyList}>
            <VerifyRow label="Factory" value={shortAddress(OPENZAP_CONTRACTS.factory)} href={configured ? explorerAddress(OPENZAP_CONTRACTS.factory) : undefined} ok={configured} />
            <VerifyRow label="Pool-bound adapter" value={shortAddress(OPENZAP_CONTRACTS.adapter)} href={configured ? explorerAddress(OPENZAP_CONTRACTS.adapter) : undefined} ok={configured} />
            <VerifyRow label="Pool ID" value={`${ROBINHOOD_LIQUIDITY.poolId.slice(0, 10)}…${ROBINHOOD_LIQUIDITY.poolId.slice(-6)}`} ok />
            <VerifyRow label="Router allowance" value="Cleared after every swap" ok />
            <VerifyRow label="Permit2 allowance" value="Cleared after every swap" ok />
            <VerifyRow label="Output protection" value="Signed minOut in OpenZap" ok />
          </div>

          <div className={styles.currentZap}>
            <span>Current zap</span>
            {zap ? (
              <>
                <a href={explorerAddress(zap.zapAddress)} target="_blank" rel="noreferrer">{zap.zapAddress}</a>
                <div><small>Required</small><strong>{formatToken(requiredAmount)} {inputSymbol}</strong></div>
                <div><small>Funded</small><strong>{formatToken(zapInputBalance)} {inputSymbol}</strong></div>
                <div><small>Wallet output</small><strong>{formatToken(walletOutputBalance)} {outputSymbol}</strong></div>
                <button className="btn btnGhost" disabled={busy !== null || zapInputBalance === 0n} onClick={() => void recoverFunds()} type="button">
                  {busy === "recover" ? "Recovering…" : "Emergency recover"}
                </button>
              </>
            ) : <p>No zap loaded.</p>}
          </div>

          <div className={styles.loadZap}>
            <label htmlFor="load-zap">Resume or recover an owned zap</label>
            <input id="load-zap" className={styles.input} placeholder="0x…" value={manualZap} onChange={(event) => setManualZap(event.target.value)} />
            <button className="btn btnGhost" disabled={!account || !configured || busy !== null || manualZap.length < 42} onClick={() => void loadExistingZap()} type="button">
              {busy === "load" ? "Loading…" : "Load verified zap"}
            </button>
          </div>
        </aside>
      </section>

      <section className={`container ${styles.receipts}`} aria-label="Transaction receipts">
        <div className={styles.receiptHead}>
          <div><span className="eyebrow">Receipts</span><h2>Confirmed wallet activity.</h2></div>
          <a href={ROBINHOOD_EXPLORER_URL} target="_blank" rel="noreferrer">Open Robinhood Blockscout ↗</a>
        </div>
        {transactions.length === 0 ? (
          <p className={styles.empty}>Transactions appear here only after Blockscout-confirmed receipts.</p>
        ) : (
          <div className={styles.txList}>
            {transactions.map((transaction) => (
              <a href={explorerTransaction(transaction.hash)} target="_blank" rel="noreferrer" key={transaction.hash}>
                <span data-status={transaction.status}>{transaction.status}</span>
                <strong>{transaction.label}</strong>
                <code>{shortHash(transaction.hash)}</code>
              </a>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function buildPolicy(owner: Address, direction: Direction, amountIn: bigint) {
  const tokenIn = direction === "buy" ? ROBINHOOD_ASSETS.weth : ROBINHOOD_ASSETS.zaps;
  return {
    owner,
    recipient: owner,
    maxRelayerFeeCap: 0n,
    optimization: true,
    trackedAssets: [ROBINHOOD_ASSETS.weth, ROBINHOOD_ASSETS.zaps],
    steps: [{
      adapter: OPENZAP_CONTRACTS.adapter,
      spender: OPENZAP_CONTRACTS.adapter,
      tokenIn,
      amountIn,
      data: "0x" as Hex,
    }],
  } as const;
}

async function quoteExactInput(direction: Direction, amountIn: bigint, account: Address): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    account,
    address: ROBINHOOD_LIQUIDITY.v4Quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{
      poolKey: robinhoodPoolKey,
      zeroForOne: direction === "buy",
      exactAmount: amountIn,
      hookData: "0x",
    }],
  });
  return result[0];
}

function requireWallet() {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("Wallet provider disconnected.");
  return createWalletClient({ chain: robinhoodChain, transport: custom(provider) });
}

async function ensureActiveChain(): Promise<void> {
  const provider = getInjectedProvider();
  if (!provider) throw new Error("Wallet provider disconnected.");
  await ensureRobinhoodChain(provider);
}

async function ensureRobinhoodChain(provider: NonNullable<ReturnType<typeof getInjectedProvider>>): Promise<void> {
  const expected = `0x${ROBINHOOD_CHAIN_ID.toString(16)}`;
  const current = await provider.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === expected) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expected }] });
  } catch (cause) {
    if (rpcErrorCode(cause) !== 4902) throw cause;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: expected,
        chainName: robinhoodChain.name,
        nativeCurrency: robinhoodChain.nativeCurrency,
        rpcUrls: [ROBINHOOD_RPC_URL],
        blockExplorerUrls: [ROBINHOOD_EXPLORER_URL],
      }],
    });
  }
}

function requireAccount(account: Address | null): Address {
  if (!account) throw new Error("Connect a wallet first.");
  return account;
}

function requireConfigured(configured: boolean): void {
  if (!configured) throw new Error("Robinhood OpenZap deployment is not configured in this build.");
}

function saveZap(owner: Address, zap: ZapRecord): void {
  window.localStorage.setItem(`${STORAGE_KEY}:${owner.toLowerCase()}`, JSON.stringify(zap));
}

function parseAmount(value: string): bigint {
  if (!value || value === ".") return 0n;
  try {
    return parseUnits(value, 18);
  } catch {
    return 0n;
  }
}

function currentTimestampMs(): bigint {
  return BigInt(new Date().getTime());
}

function sanitizeDecimal(value: string): string {
  return value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
}

function formatToken(value: bigint): string {
  const formatted = Number(formatUnits(value, 18));
  if (!Number.isFinite(formatted)) return "—";
  if (formatted === 0) return "0";
  if (formatted < 0.000001) return formatted.toExponential(3);
  return formatted.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function shortAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

function readableError(cause: unknown): string {
  if (cause instanceof Error) {
    const firstLine = cause.message.split("\n")[0];
    return firstLine.replace("User rejected the request.", "Wallet request rejected.");
  }
  return "Unknown wallet or RPC error.";
}

function rpcErrorCode(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
  return typeof cause.code === "number" ? cause.code : null;
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className={styles.metric}><strong>{value}</strong><span>{label}</span></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}

function FlowStep({ number, title, detail, done, children }: {
  number: string;
  title: string;
  detail: string;
  done: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.flowStep} data-done={done}>
      <span>{done ? "✓" : number}</span>
      <div><strong>{title}</strong><p>{detail}</p><div className={styles.flowActions}>{children}</div></div>
    </div>
  );
}

function VerifyRow({ label, value, href, ok }: { label: string; value: string; href?: string; ok: boolean }): React.JSX.Element {
  return (
    <div className={styles.verifyRow}>
      <span>{ok ? "✓" : "!"}</span>
      <div><small>{label}</small>{href ? <a href={href} target="_blank" rel="noreferrer">{value}</a> : <strong>{value}</strong>}</div>
    </div>
  );
}