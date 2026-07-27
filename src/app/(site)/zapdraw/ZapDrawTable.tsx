"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useWalletSession } from "@/components/WalletProvider";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";

import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_RPC_URL,
  erc20Abi,
  explorerAddress,
  explorerTransaction,
  getInjectedProvider,
  robinhoodChain,
} from "@/lib/robinhood";
import {
  BPS,
  MAX_SEATS,
  MIN_REVEALS,
  capacityOf,
  exportSeal,
  releasableCarry,
  findSealedDraw,
  markRevealed,
  overdrawAbi,
  overdrawAddress,
  phaseAt,
  randomSalt,
  saveSealedDraw,
  waterfall,
  type Phase,
  type RevealedDraw,
  type SealedDraw,
} from "@/lib/overdraw";
import styles from "./zapdraw.module.css";

type Busy = null | "connect" | "approve" | "commit" | "reveal" | "settle" | "claim";

/** Everything the surface reads from chain in one pass, so partial state is impossible. */
type TableState = {
  readonly round: bigint;
  readonly commitEnd: number;
  readonly revealEnd: number;
  readonly seats: number;
  readonly reveals: number;
  readonly carryPool: bigint;
  readonly entryFee: bigint;
  readonly rakeBps: number;
  readonly keeperBps: number;
  readonly stake: Address;
  readonly draws: readonly RevealedDraw[];
};

const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(ROBINHOOD_RPC_URL, { retryCount: 2, timeout: 10_000 }),
});

const EMPTY_COMMITMENT = `0x${"0".repeat(64)}` as const;

/**
 * Everything about the open round, in one read.
 *
 * Throws rather than returning a partial: a surface that renders half a round
 * as though it were a whole one is worse than one that says the RPC is down.
 */
async function readTable(game: Address): Promise<TableState> {
  const base = { address: game, abi: overdrawAbi } as const;
  const [round, entryFee, rakeBps, keeperBps, stake, carryPool] = await Promise.all([
    publicClient.readContract({ ...base, functionName: "currentRound" }),
    publicClient.readContract({ ...base, functionName: "entryFee" }),
    publicClient.readContract({ ...base, functionName: "rakeBps" }),
    publicClient.readContract({ ...base, functionName: "keeperBps" }),
    publicClient.readContract({ ...base, functionName: "stake" }),
    publicClient.readContract({ ...base, functionName: "carryPool" }),
  ]);
  const [header, players, drawValues] = await Promise.all([
    publicClient.readContract({ ...base, functionName: "rounds", args: [round] }),
    publicClient.readContract({ ...base, functionName: "revealedPlayers", args: [round] }),
    publicClient.readContract({ ...base, functionName: "revealedDraws", args: [round] }),
  ]);

  return {
    round,
    commitEnd: Number(header[0]),
    revealEnd: Number(header[1]),
    seats: Number(header[2]),
    reveals: Number(header[3]),
    carryPool,
    entryFee,
    rakeBps: Number(rakeBps),
    keeperBps: Number(keeperBps),
    stake,
    draws: players.map((player, i) => ({ player, draw: Number(drawValues[i] ?? 0) })),
  };
}

/** A seat read, tagged with the wallet and round it belongs to. */
type AccountView = {
  readonly owner: Address;
  readonly round: bigint;
  readonly seat: SeatView;
  readonly seal: SealedDraw | null;
};

type SeatView = {
  readonly committed: boolean;
  readonly revealed: boolean;
  readonly credit: bigint;
  readonly allowance: bigint;
  readonly balance: bigint;
};

async function readSeat(game: Address, stake: Address, round: bigint, account: Address): Promise<SeatView> {
  const [seat, credit, allowance, balance] = await Promise.all([
    publicClient.readContract({ address: game, abi: overdrawAbi, functionName: "seatOf", args: [round, account] }),
    publicClient.readContract({ address: game, abi: overdrawAbi, functionName: "credit", args: [account] }),
    publicClient.readContract({ address: stake, abi: erc20Abi, functionName: "allowance", args: [account, game] }),
    publicClient.readContract({ address: stake, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
  ]);
  return {
    committed: seat[0] !== EMPTY_COMMITMENT,
    revealed: Number(seat[2]) !== 0,
    credit,
    allowance,
    balance,
  };
}

const PHASE_COPY: Record<Phase, { label: string; hint: string }> = {
  commit: {
    label: "Commit",
    hint: "Pay the entry and seal a draw. Nobody — including this page — can see what you chose until you open it yourself.",
  },
  reveal: {
    label: "Reveal",
    hint: "Open your sealed draw. A seat that is never opened forfeits its entry to the pot, so this step is not optional.",
  },
  settle: {
    label: "Settle",
    hint: "The windows are closed. Anyone can discharge the bus and collect the keeper reward; the next round opens the moment they do.",
  },
};

export function ZapDrawTable(): React.JSX.Element {
  const game = useMemo(() => overdrawAddress(), []);

  // One wallet session for the whole site, owned by the root provider. This
  // surface deliberately does not open a second one: two independent listeners
  // on the same injected provider drift apart on an account switch, and the one
  // that loses the race is the one still showing the previous wallet's seat.
  const {
    account,
    chainId: walletChainId,
    status: walletStatus,
    providerAvailable,
    isRobinhoodChain,
    connect: connectWallet,
    switchToRobinhood,
  } = useWalletSession();

  const [state, setState] = useState<TableState | null>(null);
  const [rpcDown, setRpcDown] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const [drawInput, setDrawInput] = useState("2500");
  const [sealPersisted, setSealPersisted] = useState(true);

  /**
   * The account-scoped read, TAGGED with the account and round it was taken for.
   *
   * Tagged rather than reset, because a reset is a race: on an account switch
   * the old wallet's credit stays on screen until the new read lands, and the
   * one thing this panel must never do is show one wallet another wallet's
   * position. Everything below is derived from a tag match, so a mismatched
   * read is simply not rendered — there is no window in which it can be.
   */
  const [accountView, setAccountView] = useState<AccountView | null>(null);

  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [lastTx, setLastTx] = useState<Hex | null>(null);

  // ------------------------------------------------------------------ //
  // Clock                                                               //
  // ------------------------------------------------------------------ //

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // ------------------------------------------------------------------ //
  // Chain reads                                                         //
  // ------------------------------------------------------------------ //

  // Bumped after a confirmed transaction to force a re-read. Keeping the reads
  // in effects — rather than calling a state-setting helper imperatively — is
  // what lets every write to `state` happen in a promise callback, so a slow
  // RPC can never cascade renders synchronously from an effect body.
  const [tableTick, setTableTick] = useState(0);
  const [seatTick, setSeatTick] = useState(0);

  useEffect(() => {
    if (!game) return;
    let cancelled = false;
    const load = (): void => {
      readTable(game).then(
        (next) => {
          if (cancelled) return;
          setState(next);
          setRpcDown(false);
        },
        () => {
          // Keep the last good read rather than rendering zeroes. A pot shown as
          // "0" when it is really "unknown" is the one lie this surface must not
          // tell, because people size a draw against it.
          if (!cancelled) setRpcDown(true);
        },
      );
    };
    load();
    const timer = window.setInterval(load, 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [game, tableTick]);

  const round = state?.round;
  const stakeToken = state?.stake;

  useEffect(() => {
    if (!game || !account || round === undefined || stakeToken === undefined) return;
    let cancelled = false;
    readSeat(game, stakeToken, round, account).then(
      (view) => {
        if (cancelled) return;
        setAccountView({
          owner: account,
          round,
          seat: view,
          seal: findSealedDraw(ROBINHOOD_CHAIN_ID, game, round, account),
        });
      },
      () => {
        if (!cancelled) setRpcDown(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [game, account, round, stakeToken, seatTick]);

  // A read is only ever shown to the wallet and round it was taken for.
  const view = accountView !== null && accountView.owner === account && accountView.round === round
    ? accountView
    : null;
  const seal = view?.seal ?? null;
  const credit = view?.seat.credit ?? 0n;
  const allowance = view?.seat.allowance ?? 0n;
  const balance = view?.seat.balance ?? 0n;
  const mySeat = view ? { committed: view.seat.committed, revealed: view.seat.revealed } : null;

  const rescan = useCallback((): void => {
    setTableTick((n) => n + 1);
    setSeatTick((n) => n + 1);
  }, []);

  // ------------------------------------------------------------------ //
  // Derived                                                             //
  // ------------------------------------------------------------------ //

  const phase = state ? phaseAt(now, state.commitEnd, state.revealEnd) : null;
  const capacity = state
    ? capacityOf(state.seats, state.entryFee, state.rakeBps, state.keeperBps, state.carryPool)
    : 0n;
  const projection = state ? waterfall(state.draws, capacity, state.round) : null;
  const wrongChain = account !== null && !isRobinhoodChain;

  const drawBps = Number.parseInt(drawInput, 10);
  const drawValid = Number.isInteger(drawBps) && drawBps >= 1 && drawBps <= BPS;
  const wouldTake = drawValid ? (capacity * BigInt(drawBps)) / BigInt(BPS) : 0n;

  /** Where a draw of this size would land in the queue as the table stands now. */
  const queuePosition = useMemo(() => {
    if (!projection || !drawValid) return null;
    const ahead = projection.rows.filter((row) => row.draw <= drawBps).length;
    let spent = 0n;
    for (const row of projection.rows) {
      if (row.draw <= drawBps) spent += row.wants;
    }
    return { ahead, wouldSurvive: spent + wouldTake <= capacity };
  }, [projection, drawValid, drawBps, wouldTake, capacity]);

  function fmt(value: bigint): string {
    const n = Number(formatUnits(value, 18));
    if (n === 0) return "0";
    if (n < 0.0001) return "<0.0001";
    return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 4 : 2 });
  }

  function countdown(to: number): string {
    const left = to - now;
    if (left <= 0) return "closed";
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
  }

  // ------------------------------------------------------------------ //
  // Actions                                                             //
  // ------------------------------------------------------------------ //

  function clearMessages(): void {
    setNotice("");
    setError("");
  }

  function readableError(cause: unknown): string {
    if (cause instanceof Error) {
      const message = cause.message;
      if (/user rejected|denied/i.test(message)) return "You rejected the request in your wallet. Nothing was sent.";
      return message.split("\n")[0] ?? message;
    }
    return "The wallet returned an error with no message.";
  }

  async function walletFor(): Promise<{ provider: EIP1193Provider; from: Address }> {
    const provider = getInjectedProvider();
    if (!provider) throw new Error("No injected wallet found. Open MetaMask, Rabby, or another EIP-1193 wallet.");
    // Ask the shared session to move the wallet, so the network state the rest
    // of the site renders is the same one this transaction is signed against.
    if (!isRobinhoodChain) await switchToRobinhood();
    if (!account) throw new Error("Connect a wallet first.");
    return { provider, from: account };
  }

  async function connect(): Promise<void> {
    setBusy("connect");
    clearMessages();
    try {
      await connectWallet();
      setNotice("Wallet connected.");
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function send(action: Busy, run: (wallet: ReturnType<typeof createWalletClient>, from: Address) => Promise<Hex>): Promise<void> {
    setBusy(action);
    clearMessages();
    setLastTx(null);
    try {
      const { provider, from } = await walletFor();
      const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(provider) });
      const hash = await run(wallet, from);
      setLastTx(hash);
      setNotice("Submitted. Waiting for the receipt — a hash is not yet a result.");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction reverted onchain. Nothing changed.");
      setNotice("Confirmed onchain.");
      rescan();
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function approve(): Promise<void> {
    if (!game || !state) return;
    await send("approve", (wallet, from) =>
      wallet.writeContract({
        account: from,
        chain: robinhoodChain,
        address: state.stake,
        abi: erc20Abi,
        functionName: "approve",
        // Exactly one entry, not an unbounded allowance: this is a game, and a
        // standing infinite approval to it is a bigger authorisation than the
        // action needs. The cost is one approval per round.
        args: [game, state.entryFee],
      }),
    );
  }

  async function commit(): Promise<void> {
    if (!game || !state || !drawValid) return;
    const from = account;
    if (!from) return;

    const salt = randomSalt();
    let commitment: Hex;
    try {
      // Computed onchain-identically but read through our own RPC, so the draw
      // never reaches a third party before it is sealed.
      commitment = await publicClient.readContract({
        address: game,
        abi: overdrawAbi,
        functionName: "commitmentFor",
        args: [state.round, from, drawBps, salt],
      });
    } catch (cause) {
      setError(readableError(cause));
      return;
    }

    const record: SealedDraw = {
      chainId: ROBINHOOD_CHAIN_ID,
      game,
      round: state.round.toString(),
      player: from,
      draw: drawBps,
      salt,
      commitment,
      sealedAt: Date.now(),
    };
    // Persist BEFORE sending. A seal written only on success is a seal lost
    // whenever the tab dies between confirmation and callback — and a lost salt
    // is a forfeited entry that nothing can recover.
    saveSealedDraw(record);
    setAccountView((prev) =>
      prev !== null && prev.owner === from && prev.round === state.round ? { ...prev, seal: record } : prev,
    );
    setSealPersisted(findSealedDraw(ROBINHOOD_CHAIN_ID, game, state.round, from) !== null);

    await send("commit", (wallet, sender) =>
      wallet.writeContract({
        account: sender,
        chain: robinhoodChain,
        address: game,
        abi: overdrawAbi,
        functionName: "commit",
        args: [commitment],
      }),
    );
  }

  async function reveal(): Promise<void> {
    if (!game || !seal) return;
    await send("reveal", (wallet, from) =>
      wallet.writeContract({
        account: from,
        chain: robinhoodChain,
        address: game,
        abi: overdrawAbi,
        functionName: "reveal",
        args: [seal.draw, seal.salt],
      }),
    );
    markRevealed(seal, Date.now());
  }

  async function settle(): Promise<void> {
    if (!game) return;
    await send("settle", (wallet, from) =>
      wallet.writeContract({
        account: from,
        chain: robinhoodChain,
        address: game,
        abi: overdrawAbi,
        functionName: "settle",
      }),
    );
  }

  async function claim(): Promise<void> {
    if (!game) return;
    await send("claim", (wallet, from) =>
      wallet.writeContract({
        account: from,
        chain: robinhoodChain,
        address: game,
        abi: overdrawAbi,
        functionName: "claim",
      }),
    );
  }

  // ------------------------------------------------------------------ //
  // Render                                                              //
  // ------------------------------------------------------------------ //

  if (!game) {
    return (
      <section className={styles.closed} aria-live="polite">
        <p className={styles.closedTag}>Not deployed</p>
        <h2 className={styles.closedTitle}>There is no table to sit at yet.</h2>
        <p className={styles.closedBody}>
          ZapDraw&apos;s contract is written and tested but not deployed to Robinhood Chain, so this page has
          no round to show you and no address to take 0xZAPS to. It stays this way until a real deployment is
          configured — a game surface that renders a plausible-looking table over a contract that does not
          exist is how people lose money to a screenshot.
        </p>
        <p className={styles.closedBody}>
          The rules below are the contract&apos;s, not a mock-up. Read them now; the game will not change shape
          when it opens.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.table}>
      {/* -------- status bar -------- */}
      <header className={styles.bar}>
        <div className={styles.barMain}>
          <span className={styles.round}>{state ? `Round ${state.round}` : "Round —"}</span>
          {phase ? (
            <span className={styles.phase} data-phase={phase}>
              {PHASE_COPY[phase].label}
            </span>
          ) : null}
        </div>
        <div className={styles.barClock}>
          {state && phase === "commit" ? <span>Commits close in {countdown(state.commitEnd)}</span> : null}
          {state && phase === "reveal" ? <span>Reveals close in {countdown(state.revealEnd)}</span> : null}
          {state && phase === "settle" ? <span>Awaiting settlement</span> : null}
        </div>
      </header>

      {rpcDown ? (
        <p className={styles.warn} role="status">
          Robinhood RPC is unreachable, so the numbers below are the last good read and may be stale. Nothing
          here is showing you a zero it invented.
        </p>
      ) : null}

      {wrongChain ? (
        <p className={styles.warn} role="status">
          Your wallet is on chain {walletChainId ?? "an unknown network"}. ZapDraw lives on Robinhood Chain (
          {ROBINHOOD_CHAIN_ID}); any action below will ask you to switch first.
        </p>
      ) : null}

      {/* -------- the bus -------- */}
      <div className={styles.grid}>
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>The bus</h3>
          <dl className={styles.facts}>
            <div>
              <dt>Capacity</dt>
              <dd className={styles.big}>{state ? `${fmt(capacity)} 0xZAPS` : "—"}</dd>
            </div>
            <div>
              <dt>Seats taken</dt>
              <dd>
                {state ? `${state.seats} / ${MAX_SEATS}` : "—"}
              </dd>
            </div>
            <div>
              <dt>Draws revealed</dt>
              <dd>{state ? state.reveals : "—"}</dd>
            </div>
            <div>
              <dt>Entry</dt>
              <dd>{state ? `${fmt(state.entryFee)} 0xZAPS` : "—"}</dd>
            </div>
            <div>
              <dt>Carry pool</dt>
              <dd>{state ? `${fmt(state.carryPool)} 0xZAPS` : "—"}</dd>
            </div>
          </dl>
          {state && state.carryPool > 0n ? (
            <p className={styles.note}>
              Of that pool, only{" "}
              <strong>{fmt(releasableCarry(state.seats, state.entryFee, state.rakeBps, state.carryPool))} 0xZAPS</strong>{" "}
              can enter this round — a round may draw on the pool up to the rake it pays, and no
              further. Without that cap, anyone who took every seat would recover their entries and
              pocket the pool on top.
            </p>
          ) : null}
          {state && state.reveals < MIN_REVEALS ? (
            <p className={styles.note}>
              A round needs {MIN_REVEALS} revealed draws before the bus discharges at all. Below that the whole
              capacity returns to the carry pool.
            </p>
          ) : null}
          <p className={styles.fine}>
            Contract{" "}
            <a href={explorerAddress(game)} target="_blank" rel="noreferrer">
              {game}
            </a>
          </p>
        </div>

        {/* -------- your seat -------- */}
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Your seat</h3>

          {!account ? (
            <>
              <p className={styles.note}>
                Connecting only reads your address. It does not move a token and does not commit you to a round.
              </p>
              <button
                type="button"
                className={styles.primary}
                onClick={() => void connect()}
                disabled={busy !== null || walletStatus === "checking" || !providerAvailable}
                title={!providerAvailable && walletStatus !== "checking" ? "No injected EIP-1193 wallet was found." : undefined}
              >
                {busy === "connect"
                  ? "Connecting…"
                  : walletStatus === "checking"
                    ? "Checking wallet…"
                    : providerAvailable
                      ? "Connect wallet"
                      : "No wallet found"}
              </button>
            </>
          ) : (
            <>
              <dl className={styles.facts}>
                <div>
                  <dt>Wallet</dt>
                  <dd className={styles.mono}>
                    {account.slice(0, 6)}…{account.slice(-4)}
                  </dd>
                </div>
                <div>
                  <dt>0xZAPS balance</dt>
                  <dd>{fmt(balance)}</dd>
                </div>
                <div>
                  <dt>Claimable</dt>
                  <dd className={credit > 0n ? styles.win : undefined}>{fmt(credit)}</dd>
                </div>
              </dl>

              {credit > 0n ? (
                <button type="button" className={styles.primary} onClick={() => void claim()} disabled={busy !== null}>
                  {busy === "claim" ? "Claiming…" : `Claim ${fmt(credit)} 0xZAPS`}
                </button>
              ) : null}

              {/* commit */}
              {phase === "commit" && state ? (
                mySeat?.committed ? (
                  <p className={styles.note}>
                    You hold a seat in round {String(state.round)}. Come back during the reveal window to open it —
                    a seat never opened forfeits its entry.
                  </p>
                ) : (
                  <div className={styles.form}>
                    <label className={styles.label} htmlFor="draw">
                      Your draw — how much of the capacity you claim
                    </label>
                    <div className={styles.drawRow}>
                      <input
                        id="draw"
                        className={styles.input}
                        type="range"
                        min={1}
                        max={BPS}
                        step={25}
                        value={drawValid ? drawBps : 2500}
                        onChange={(e) => setDrawInput(e.target.value)}
                      />
                      <output className={styles.drawValue}>{drawValid ? (drawBps / 100).toFixed(2) : "—"}%</output>
                    </div>
                    <p className={styles.projection}>
                      At today&apos;s capacity that draw asks for <strong>{fmt(wouldTake)} 0xZAPS</strong>.{" "}
                      {queuePosition
                        ? queuePosition.wouldSurvive
                          ? "Against the draws revealed so far it would be served — but every reveal after this one changes that."
                          : "Against the draws revealed so far the bus would already be dry before it reached you."
                        : null}
                    </p>
                    {allowance < state.entryFee ? (
                      <button type="button" className={styles.primary} onClick={() => void approve()} disabled={busy !== null}>
                        {busy === "approve" ? "Approving…" : `Approve ${fmt(state.entryFee)} 0xZAPS`}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.primary}
                        onClick={() => void commit()}
                        disabled={busy !== null || !drawValid || balance < state.entryFee}
                      >
                        {busy === "commit" ? "Sealing…" : `Pay ${fmt(state.entryFee)} 0xZAPS and seal`}
                      </button>
                    )}
                    {balance < state.entryFee ? (
                      <p className={styles.warn}>Your 0xZAPS balance is below the entry for this round.</p>
                    ) : null}
                  </div>
                )
              ) : null}

              {/* reveal */}
              {phase === "reveal" && state ? (
                !mySeat?.committed ? (
                  <p className={styles.note}>You have no seat in round {String(state.round)}. Wait for the next one.</p>
                ) : mySeat.revealed ? (
                  <p className={styles.note}>
                    Your draw of {seal ? (seal.draw / 100).toFixed(2) : "—"}% is open and in the queue. Nothing more to
                    do until settlement.
                  </p>
                ) : seal ? (
                  <div className={styles.form}>
                    <p className={styles.note}>
                      Opening a sealed draw of <strong>{(seal.draw / 100).toFixed(2)}%</strong>.
                    </p>
                    <button type="button" className={styles.primary} onClick={() => void reveal()} disabled={busy !== null}>
                      {busy === "reveal" ? "Opening…" : "Open my draw"}
                    </button>
                  </div>
                ) : (
                  <p className={styles.warn}>
                    You hold a seat but this browser has no record of its salt, so it cannot be opened here. If you
                    exported the seal, paste it back into this browser&apos;s storage; otherwise the entry is
                    forfeit when the window closes. This is the failure mode a sealed bid cannot protect you from.
                  </p>
                )
              ) : null}

              {/* settle */}
              {phase === "settle" ? (
                <div className={styles.form}>
                  <p className={styles.note}>
                    The round is ready to discharge. Anyone can do it and the caller is credited the keeper reward.
                  </p>
                  <button type="button" className={styles.primary} onClick={() => void settle()} disabled={busy !== null}>
                    {busy === "settle" ? "Discharging…" : "Settle the round"}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* -------- the seal -------- */}
      {seal && !seal.revealedAt ? (
        <div className={styles.seal}>
          <h3 className={styles.panelTitle}>Keep this. It is the only way to open your draw.</h3>
          <p className={styles.note}>
            Your draw is sealed with a random salt held in this browser only. Clear this site&apos;s data before
            the reveal window and your seat becomes unopenable — and an unopened seat forfeits its entry by design.
            Copy the backup below if you might return in a different browser.
          </p>
          <pre className={styles.sealBlob}>{exportSeal(seal)}</pre>
          {!sealPersisted ? (
            <p className={styles.warn}>
              This browser refused to persist the seal (storage full or blocked). Copy the block above now — it is
              the only copy that exists.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* -------- the queue -------- */}
      {state && state.draws.length > 0 && projection ? (
        <div className={styles.queue}>
          <h3 className={styles.panelTitle}>The queue as it stands</h3>
          <p className={styles.note}>
            A projection over the draws revealed so far, not a result. Settlement runs on the draws present when
            the reveal window closes, and every reveal between now and then moves this line.
          </p>
          <table className={styles.rows}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col">Draw</th>
                <th scope="col">Would take</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {projection.rows.map((row, i) => (
                <tr key={`${row.player}-${i}`} data-me={account !== null && row.player.toLowerCase() === account.toLowerCase()}>
                  <td>{i + 1}</td>
                  <td className={styles.mono}>
                    {row.player.slice(0, 6)}…{row.player.slice(-4)}
                  </td>
                  <td>{(row.draw / 100).toFixed(2)}%</td>
                  <td>{fmt(row.wants)}</td>
                  <td className={row.served ? styles.served : styles.cut}>
                    {projection.stalled ? "held" : row.served ? "served" : "cut"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={styles.fine}>
            {projection.stalled
              ? `Fewer than ${MIN_REVEALS} draws revealed — the whole capacity would carry.`
              : `${fmt(projection.served)} 0xZAPS would be delivered, ${fmt(projection.carry)} would stay charged for the next round.`}
          </p>
        </div>
      ) : null}

      {/* -------- messages -------- */}
      {notice ? (
        <p className={styles.notice} role="status">
          {notice}
          {lastTx ? (
            <>
              {" "}
              <a href={explorerTransaction(lastTx)} target="_blank" rel="noreferrer">
                View transaction
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {error ? (
        <p className={styles.warn} role="alert">
          {error}
        </p>
      ) : null}

      {phase ? <p className={styles.fine}>{PHASE_COPY[phase].hint}</p> : null}
    </section>
  );
}
