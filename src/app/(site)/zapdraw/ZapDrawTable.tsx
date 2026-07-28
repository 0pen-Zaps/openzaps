"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Glyph } from "@/components/Glyph";
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
  /**
   * Whether the open round has already been discharged.
   *
   * Read because `phase` is derived from the browser clock against a cached
   * header: after a settle lands, a page holding the previous read still
   * computes `phase === "settle"` and offers the Settle button, which then
   * reverts `RevealWindowOpen`. "The transaction reverted onchain" right after
   * successfully settling is what makes the next round look broken.
   */
  readonly settled: boolean;
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
    settled: Boolean(header[4]),
    carryPool,
    entryFee,
    rakeBps: Number(rakeBps),
    keeperBps: Number(keeperBps),
    stake,
    draws: players.map((player, i) => ({ player, draw: Number(drawValues[i] ?? 0) })),
  };
}

/**
 * What happened in the round before this one.
 *
 * Without this the previous round simply disappears the moment `currentRound`
 * advances: a player whose entry was forfeited sees no result, no receipt, and
 * no explanation for why the carry pool grew. The live game's round 1 ended
 * 2 seats / 0 reveals, and nothing on the page ever said so.
 */
type PriorRound = {
  readonly round: bigint;
  readonly seats: number;
  readonly reveals: number;
  readonly settled: boolean;
  /** Whether this wallet held a seat, and whether it opened it. */
  readonly mine: { committed: boolean; revealed: boolean } | null;
};

async function readPriorRound(game: Address, round: bigint, account: Address | null): Promise<PriorRound | null> {
  if (round <= 1n) return null;
  const prior = round - 1n;
  const base = { address: game, abi: overdrawAbi } as const;
  const header = await publicClient.readContract({ ...base, functionName: "rounds", args: [prior] });
  let mine: PriorRound["mine"] = null;
  if (account) {
    const seat = await publicClient.readContract({ ...base, functionName: "seatOf", args: [prior, account] });
    mine = { committed: seat[0] !== EMPTY_COMMITMENT, revealed: Number(seat[2]) !== 0 };
  }
  return {
    round: prior,
    seats: Number(header[2]),
    reveals: Number(header[3]),
    settled: Boolean(header[4]),
    mine,
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
    hint: "The windows are closed. Anyone can discharge the bus and is credited the keeper reward for doing it; the next round opens the moment they do.",
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
  /** A seat read failed and has not since succeeded. Distinct from `rpcDown`. */
  const [seatUnread, setSeatUnread] = useState(false);
  const [prior, setPrior] = useState<PriorRound | null>(null);
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

  /**
   * The seat read POLLS, exactly like the table read.
   *
   * It used to fire once per (round, account) and never again. That looks
   * harmless until the one call fails: `accountView` stays null, which the
   * reveal panel below renders as the sentence "You have no seat in round N,
   * wait for the next one" — advice to do nothing, shown during the six hours
   * in which doing nothing forfeits the entry fee. Round 1 of the live game
   * ended 2 seats / 0 reveals.
   *
   * So: retry on a cadence, and keep the failure distinguishable from a real
   * empty seat (`seatKnown` below). A read we could not take must never render
   * as a seat that is not there.
   */
  useEffect(() => {
    if (!game || !account || round === undefined || stakeToken === undefined) return;
    let cancelled = false;
    const load = (): void => {
      readSeat(game, stakeToken, round, account).then(
        (view) => {
          if (cancelled) return;
          setAccountView({
            owner: account,
            round,
            seat: view,
            seal: findSealedDraw(ROBINHOOD_CHAIN_ID, game, round, account),
          });
          setSeatUnread(false);
        },
        () => {
          // Deliberately NOT setRpcDown: the table poll clears that flag every
          // 12s, so a seat-only failure would flash a warning and then hide
          // itself while the seat stayed unknown. This flag is only cleared by
          // a seat read that actually succeeds.
          if (!cancelled) setSeatUnread(true);
        },
      );
    };
    load();
    const timer = window.setInterval(load, 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [game, account, round, stakeToken, seatTick]);

  // The previous round's outcome. Read alongside the seat so it refreshes when
  // the round turns over, and failure-tolerant: no receipt is better than a
  // wrong one, and the live table above is unaffected either way.
  useEffect(() => {
    if (!game || round === undefined) return;
    let cancelled = false;
    readPriorRound(game, round, account).then(
      (result) => {
        if (!cancelled) setPrior(result);
      },
      () => {
        if (!cancelled) setPrior(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [game, round, account, seatTick]);

  // A read is only ever shown to the wallet and round it was taken for.
  const view = accountView !== null && accountView.owner === account && accountView.round === round
    ? accountView
    : null;
  const seal = view?.seal ?? null;
  const credit = view?.seat.credit ?? 0n;
  const allowance = view?.seat.allowance ?? 0n;
  const balance = view?.seat.balance ?? 0n;
  const mySeat = view ? { committed: view.seat.committed, revealed: view.seat.revealed } : null;

  /**
   * Have we actually read this wallet's seat for this round?
   *
   * `mySeat === null` conflates two states that must never be shown the same
   * way — "you have no seat" and "we do not know yet". Only the first is safe
   * to act on.
   */
  const seatKnown = view !== null;

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

  // An empty round genuinely has a capacity of zero, but rendering a big accent
  // "0 0xZAPS" as the first thing a visitor sees reads as broken rather than as
  // an open table. Show instead what taking a seat would put on the bus.
  const perSeat = state
    ? (state.entryFee * BigInt(BPS - state.rakeBps - state.keeperBps)) / BigInt(BPS)
    : 0n;
  const emptyTable = state !== null && state.seats === 0 && capacity === 0n;

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

  /**
   * The seat card's connection light. Presentational only — every gate below
   * still reads `account` / `isRobinhoodChain` directly, so a mislabelled dot
   * could never let an action through.
   */
  const connection: { tone: "ok" | "warn" | "idle"; label: string } = account
    ? isRobinhoodChain
      ? { tone: "ok", label: "connected" }
      : { tone: "warn", label: "wrong chain" }
    : walletStatus === "checking"
      ? { tone: "idle", label: "checking…" }
      : { tone: "idle", label: "not connected" };

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
        // action needs. The cost is one approval per round, and the hint under
        // the button promises exactly this.
        args: [game, state.entryFee],
      }),
    );
  }

  async function commit(): Promise<void> {
    if (!game || !state || !drawValid) return;
    const from = account;
    if (!from) return;

    const salt = randomSalt();
    let liveRound: bigint;
    let commitment: Hex;
    try {
      /**
       * Re-read the round id, immediately, and seal against THAT.
       *
       * `state.round` is up to 12s stale, and `commit(bytes32)` takes no round
       * id — so the contract cannot reject a blob sealed for the wrong round.
       * If anyone settles in that window, the entry lands in round N+1 carrying
       * a commitment bound to N: `reveal` reverts BadReveal forever, the seat
       * forfeits, and the salt vault (keyed by round) reports "no record" for a
       * salt it is actually holding. Nothing downstream can detect or undo it.
       */
      liveRound = await publicClient.readContract({
        address: game,
        abi: overdrawAbi,
        functionName: "currentRound",
      });
      // Computed onchain-identically but read through our own RPC, so the draw
      // never reaches a third party before it is sealed.
      commitment = await publicClient.readContract({
        address: game,
        abi: overdrawAbi,
        functionName: "commitmentFor",
        args: [liveRound, from, drawBps, salt],
      });
    } catch (cause) {
      setError(readableError(cause));
      return;
    }

    if (liveRound !== state.round) {
      // The round turned over while this page was showing the old one. Refuse
      // rather than seal — the numbers on screen (capacity, queue, the draws
      // ranked against yours) all describe a round that is now closed.
      setError(
        `Round ${String(state.round)} closed while you were choosing; round ${String(liveRound)} is open now. The table has been refreshed — review the new capacity and seal again.`,
      );
      rescan();
      return;
    }

    const record: SealedDraw = {
      chainId: ROBINHOOD_CHAIN_ID,
      game,
      round: liveRound.toString(),
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
    <>
      {/* -------- round bar -------- */}
      <div className={styles.roundBar}>
        <strong className={styles.roundId}>{state ? `Round ${state.round}` : "Round —"}</strong>
        {phase ? (
          <span className={styles.phase} data-phase={phase}>
            {PHASE_COPY[phase].label}
          </span>
        ) : null}
        {state && phase === "commit" ? (
          <span className={styles.roundClock}>
            Commits close in <strong className={styles.roundClockValue}>{countdown(state.commitEnd)}</strong>
          </span>
        ) : null}
        {state && phase === "reveal" ? (
          <span className={styles.roundClock}>
            Reveals close in <strong className={styles.roundClockValue}>{countdown(state.revealEnd)}</strong>
          </span>
        ) : null}
        {state && phase === "settle" ? <span className={styles.roundClock}>Awaiting settlement</span> : null}
        {phase ? <span className={styles.roundHint}>{PHASE_COPY[phase].hint}</span> : null}
      </div>

      {/* An unopened seat is the only way to lose money here without doing
          anything, so it gets the loudest, highest thing on the page — during
          the commit window too, when the reveal is still hours away and easiest
          to forget. Round 1 of the live game ended 2 seats / 0 reveals. */}
      {state && mySeat?.committed && !mySeat.revealed && phase !== "settle" ? (
        <p className={styles.banner} data-tone="danger" role="status">
          {phase === "reveal" ? (
            <>
              <strong>Open your draw now.</strong> You hold a seat in round {String(state.round)} and the reveal
              window closes in <strong>{countdown(state.revealEnd)}</strong>. A seat that is never opened forfeits
              its entry of {fmt(state.entryFee)} 0xZAPS — no refund, no exception.
            </>
          ) : (
            <>
              <strong>You hold a seat in round {String(state.round)}.</strong> Come back to open it between{" "}
              {new Date(state.commitEnd * 1000).toLocaleString()} and{" "}
              {new Date(state.revealEnd * 1000).toLocaleString()}. A seat that is never opened forfeits its entry
              of {fmt(state.entryFee)} 0xZAPS.
            </>
          )}
        </p>
      ) : null}

      {rpcDown ? (
        <p className={styles.banner} data-tone="warn" role="status">
          Robinhood RPC is unreachable. The numbers below are the last good read and may be stale; where no
          read has landed they stay blank. Nothing here is showing you a zero it invented.
        </p>
      ) : null}

      {seatUnread ? (
        <p className={styles.banner} data-tone="warn" role="status">
          Could not read your seat for this round — retrying every few seconds. Until it clears, this page cannot
          tell you whether you hold one, so do not assume you are out.
        </p>
      ) : null}

      {wrongChain ? (
        <p className={styles.banner} data-tone="warn" role="status">
          Your wallet is on chain {walletChainId ?? "an unknown network"}. ZapDraw lives on Robinhood Chain (
          {ROBINHOOD_CHAIN_ID}); any action below will ask you to switch first.
        </p>
      ) : null}

      <div className={styles.panels}>
        {/* -------- the bus -------- */}
        <section className={styles.card} aria-busy={state === null}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>The bus</h2>
            <span className={styles.cardSub}>what there is to be served from</span>
          </div>

          <div className={styles.busHero}>
            <strong className={styles.busHeroValue} data-unknown={state === null}>
              {!state ? "—" : emptyTable ? "Empty" : fmt(capacity)}
            </strong>
            {emptyTable ? null : <span className={styles.busHeroUnit}>0xZAPS capacity</span>}
          </div>

          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Seats taken</dt>
              <dd className={styles.factValue}>{state ? `${state.seats} / ${MAX_SEATS}` : "—"}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Draws revealed</dt>
              {/* While commits are open the count is always 0 and says nothing on
                  its own; what a reader actually wants is when it starts moving. */}
              <dd className={styles.factValue}>
                {!state
                  ? "—"
                  : phase === "commit"
                    ? `${state.reveals} — reveals open in ${countdown(state.commitEnd)}`
                    : String(state.reveals)}
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Entry</dt>
              <dd className={styles.factValue}>{state ? `${fmt(state.entryFee)} 0xZAPS` : "—"}</dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>Carry pool</dt>
              <dd className={styles.factValue}>{state ? `${fmt(state.carryPool)} 0xZAPS` : "—"}</dd>
            </div>
          </dl>

          {state && state.carryPool > 0n ? (
            <>
              <p className={styles.cardNote}>
                Of that pool, only{" "}
                <strong>{fmt(releasableCarry(state.seats, state.entryFee, state.rakeBps, state.carryPool))} 0xZAPS</strong>{" "}
                can enter this round — a round may draw on the pool up to the rake it pays, and no
                further. Without that cap, anyone who took every seat would recover their entries and
                pocket the pool on top.
              </p>
              {state.seats < MIN_REVEALS + 2 ? (
                /* Say the uncomfortable part. At this seat count the pool grows
                   far faster than the cap lets it drain, so presenting a large
                   carry number without this reads as money that is coming
                   back. It is not — not at this table size. */
                <p className={styles.cardNote} data-tone="warn">
                  At {state.seats} {state.seats === 1 ? "seat" : "seats"} the cap releases far less per round than an
                  under-subscribed round adds, so this pool grows rather than pays out. It takes a fuller table to
                  draw it down.
                </p>
              ) : null}
            </>
          ) : null}

          {prior && prior.settled ? (
            <div className={styles.cardNote} data-tone={prior.mine?.committed && !prior.mine.revealed ? "danger" : undefined}>
              <strong>Round {String(prior.round)}:</strong>{" "}
              {prior.reveals < MIN_REVEALS ? (
                <>
                  {prior.seats} {prior.seats === 1 ? "seat" : "seats"} took part but only {prior.reveals}{" "}
                  {prior.reveals === 1 ? "draw was" : "draws were"} opened — under the {MIN_REVEALS} a round needs to
                  discharge, so the bus paid nobody and the whole capacity went to the carry pool.
                </>
              ) : (
                <>
                  {prior.seats} {prior.seats === 1 ? "seat" : "seats"}, {prior.reveals} opened. Settled.
                </>
              )}
              {prior.mine?.committed ? (
                prior.mine.revealed ? (
                  <> You opened your draw. Anything you won is in your credit balance, ready to claim.</>
                ) : (
                  <> <strong>You held a seat and never opened it, so your entry was forfeited to the pool.</strong> A
                  sealed draw only counts once it is revealed during the reveal window.</>
                )
              ) : null}
            </div>
          ) : null}
          {emptyTable ? (
            <p className={styles.cardNote}>
              Nobody has sat down yet. Each seat puts <strong>{fmt(perSeat)} 0xZAPS</strong> on the bus —
              the {fmt(state.entryFee)} entry less the {((state.rakeBps + state.keeperBps) / 100).toFixed(2)}%
              that leaves as rake and keeper reward.
            </p>
          ) : null}

          {state && state.reveals < MIN_REVEALS ? (
            <p className={styles.cardNote}>
              A round needs {MIN_REVEALS} revealed draws before the bus discharges at all. Below that the whole
              capacity returns to the carry pool.
            </p>
          ) : null}

          <p className={styles.cardFine}>
            Contract{" "}
            {/* The FULL checksummed address, never a truncation: this is the
                string people paste into the explorer to check they are on the
                thing the page claims. */}
            <a href={explorerAddress(game)} target="_blank" rel="noreferrer">
              {game}
            </a>{" "}
            · no admin, no pause, no upgrade path
          </p>
        </section>

        {/* -------- your seat -------- */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Your seat</h2>
            <span className={styles.cardStatus} data-tone={connection.tone}>
              <i className={styles.statusDot} />
              {connection.label}
            </span>
          </div>

          {account ? (
            <>
              <div className={styles.seatRow}>
                <span className={styles.seatLabel}>Wallet</span>
                <code className={styles.seatCode}>
                  {account.slice(0, 6)}…{account.slice(-4)}
                </code>
              </div>
              <div className={styles.seatRow}>
                <span className={styles.seatLabel}>0xZAPS balance</span>
                {/* `—` until the tagged read lands. A zero here would be a claim
                    about this wallet that no read has actually made. */}
                <span className={styles.seatValue}>{view ? fmt(balance) : "—"}</span>
              </div>
              <div className={`${styles.seatRow} ${styles.seatRowLast}`}>
                <span className={styles.seatLabel}>Claimable</span>
                <span className={styles.seatValueGroup}>
                  <strong className={credit > 0n ? styles.factValueOk : styles.seatValue}>
                    {view ? fmt(credit) : "—"}
                  </strong>
                  {credit > 0n ? (
                    <button
                      type="button"
                      className={styles.ghostButton}
                      onClick={() => void claim()}
                      disabled={busy !== null}
                      data-busy={busy === "claim"}
                    >
                      {busy === "claim" ? <i className={styles.spinner} aria-hidden /> : null}
                      {busy === "claim" ? "Claiming…" : "Claim"}
                    </button>
                  ) : null}
                </span>
              </div>
            </>
          ) : null}

          <div className={styles.form}>
            {!account ? (
              <>
                <p className={styles.formNote}>
                  Connecting only reads your address. It does not move a token and does not commit you to a round.
                </p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.primary}
                    onClick={() => void connect()}
                    disabled={busy !== null || walletStatus === "checking" || !providerAvailable}
                    data-busy={busy === "connect"}
                    title={!providerAvailable && walletStatus !== "checking" ? "No injected EIP-1193 wallet was found." : undefined}
                  >
                    {busy === "connect" ? <i className={styles.spinner} aria-hidden /> : null}
                    {busy === "connect"
                      ? "Connecting…"
                      : walletStatus === "checking"
                        ? "Checking wallet…"
                        : providerAvailable
                          ? "Connect wallet"
                          : "No wallet found"}
                  </button>
                </div>
              </>
            ) : (
              <>
                {/* commit */}
                {phase === "commit" && state ? (
                  !seatKnown ? (
                    /* Offering the commit form here would invite a second entry
                       for a round that may already hold one — the contract
                       reverts SeatTaken, but only after a wallet prompt. */
                    <p className={styles.formNote} data-state="checking">
                      {seatUnread
                        ? "Could not read your seat — retrying. Hold off on entering until this clears, so you do not pay twice for one round."
                        : `Checking whether you already hold a seat in round ${String(state.round)}…`}
                    </p>
                  ) : mySeat?.committed ? (
                    <p className={styles.formNote}>
                      You hold a seat in round {String(state.round)}. Come back during the reveal window to open it —
                      a seat never opened forfeits its entry.
                    </p>
                  ) : (
                    <>
                      <label className={styles.formLabel} htmlFor="draw">
                        Your draw — how much of the capacity you claim
                      </label>
                      <div className={styles.drawRow}>
                        <input
                          id="draw"
                          className={styles.range}
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
                        At the capacity on the bus now, that draw asks for <strong>{fmt(wouldTake)} 0xZAPS</strong>.{" "}
                        {queuePosition ? (
                          <span className={queuePosition.wouldSurvive ? styles.verdictOk : styles.verdictBad}>
                            {queuePosition.wouldSurvive
                              ? "No draw is open yet, so there is nothing to rank you against — what the rest of the table opens decides whether the bus reaches you."
                              : "The draws already open would leave the bus dry before it reached you."}
                          </span>
                        ) : null}
                      </p>
                      <div className={styles.actions}>
                        {allowance < state.entryFee ? (
                          <button
                            type="button"
                            className={styles.primary}
                            onClick={() => void approve()}
                            disabled={busy !== null}
                            data-busy={busy === "approve"}
                          >
                            {busy === "approve" ? <i className={styles.spinner} aria-hidden /> : null}
                            {busy === "approve" ? "Approving…" : `Approve ${fmt(state.entryFee)} 0xZAPS`}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className={styles.primary}
                            onClick={() => void commit()}
                            disabled={busy !== null || !drawValid || balance < state.entryFee}
                            data-busy={busy === "commit"}
                          >
                            {busy === "commit" ? <i className={styles.spinner} aria-hidden /> : null}
                            {busy === "commit" ? "Sealing…" : `Pay ${fmt(state.entryFee)} 0xZAPS and seal`}
                          </button>
                        )}
                        <span className={styles.actionHint}>
                          {allowance < state.entryFee
                            ? "Approves exactly one entry — never an unbounded allowance."
                            : "Spends the one entry you approved and leaves no standing allowance."}
                        </span>
                      </div>
                      {balance < state.entryFee ? (
                        <p className={styles.banner} data-tone="warn">
                          Your 0xZAPS balance is below the entry for this round.
                        </p>
                      ) : null}
                      <div className={styles.saltNote}>
                        <Glyph name="lock" className={styles.saltIcon} />
                        <p>
                          Sealing stores a random salt in this browser and shows you an exportable copy. Clear
                          this site&apos;s data before you reveal and the seat cannot be opened — an unopened seat
                          forfeits its entry.
                        </p>
                      </div>
                    </>
                  )
                ) : null}

                {/* reveal */}
                {phase === "reveal" && state ? (
                  !seatKnown ? (
                    /* Not "you have no seat" — we do not know yet. Saying the
                       former during the reveal window is advice to do nothing,
                       and doing nothing here forfeits the entry. */
                    <p className={styles.formNote} data-state="checking">
                      {seatUnread
                        ? "Could not read your seat — retrying every few seconds. Do not close this page: if you hold a seat in this round, it must be opened before the window closes or its entry is forfeited."
                        : `Checking whether you hold a seat in round ${String(state.round)}…`}
                    </p>
                  ) : !mySeat?.committed ? (
                    <p className={styles.formNote}>
                      You have no seat in round {String(state.round)}. Wait for the next one.
                    </p>
                  ) : mySeat.revealed ? (
                    <p className={styles.formNote}>
                      Your draw of {seal ? (seal.draw / 100).toFixed(2) : "—"}% is open and in the queue. Nothing more to
                      do until settlement.
                    </p>
                  ) : seal ? (
                    <>
                      <p className={styles.formNote}>
                        Opening a sealed draw of <strong>{(seal.draw / 100).toFixed(2)}%</strong>.
                      </p>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.primary}
                          onClick={() => void reveal()}
                          disabled={busy !== null}
                          data-busy={busy === "reveal"}
                        >
                          {busy === "reveal" ? <i className={styles.spinner} aria-hidden /> : null}
                          {busy === "reveal" ? "Opening…" : "Open my draw"}
                        </button>
                      </div>
                    </>
                  ) : (
                    /* A forfeited entry, not a caution: this is the one branch
                       where doing nothing costs money. */
                    <p className={styles.banner} data-tone="danger">
                      You hold a seat but this browser has no record of its salt, so it cannot be opened here. If you
                      exported the seal, paste it back into this browser&apos;s storage; otherwise the entry is
                      forfeit when the window closes. This is the failure mode a sealed bid cannot protect you from.
                    </p>
                  )
                ) : null}

                {/* settle */}
                {phase === "settle" && state ? (
                  state.settled ? (
                    /* Already discharged. `phase` is derived from the browser
                       clock against a cached header, so without this the button
                       stays offered after a successful settle and the next
                       click reverts RevealWindowOpen — which reads as the new
                       round being broken. */
                    <p className={styles.formNote} role="status">
                      Round {String(state.round)} is already settled. The next round is opening — this table refreshes
                      on its own within a few seconds.
                    </p>
                  ) : (
                    <>
                      <p className={styles.formNote}>
                        The round is ready to discharge. Anyone can do it and the caller is credited the keeper reward.
                      </p>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.primary}
                          onClick={() => void settle()}
                          disabled={busy !== null}
                          data-busy={busy === "settle"}
                        >
                          {busy === "settle" ? <i className={styles.spinner} aria-hidden /> : null}
                          {busy === "settle" ? "Discharging…" : "Settle the round"}
                        </button>
                      </div>
                    </>
                  )
                ) : null}
              </>
            )}

            {/* Feedback sits beside the control that caused it, not at the foot
                of the page where an in-flight write scrolls out of sight. */}
            {notice ? (
              <p className={styles.banner} data-tone="info" role="status">
                {notice}
                {lastTx ? (
                  <>
                    {" "}
                    <a
                      href={explorerTransaction(lastTx)}
                      target="_blank"
                      rel="noreferrer"
                      className={styles.bannerLink}
                    >
                      View transaction
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            {error ? (
              <p className={styles.banner} data-tone="danger" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </section>
      </div>

      {/* -------- the seal -------- */}
      {seal && !seal.revealedAt ? (
        <section className={styles.sealCard}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Keep this. It is the only way to open your draw.</h2>
          </div>
          <p className={styles.cardNote}>
            Your draw is sealed with a random salt held in this browser only. Clear this site&apos;s data before
            the reveal window and your seat becomes unopenable — and an unopened seat forfeits its entry by design.
            Copy the backup below if you might return in a different browser.
          </p>
          <pre className={styles.sealBlob}>{exportSeal(seal)}</pre>
          {!sealPersisted ? (
            <p className={styles.banner} data-tone="danger">
              This browser refused to persist the seal (storage full or blocked). Copy the block above now — it is
              the only copy that exists.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* -------- the queue -------- */}
      {state && state.draws.length > 0 && projection ? (
        <>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>The queue as it stands</h2>
            <span className={styles.sectionSub}>
              Sorted ascending and paid in full while the current lasts.
            </span>
          </div>
          <section className={styles.queueCard}>
            <p className={styles.queueIntro}>
              A projection over the draws revealed so far, not a result. Settlement runs on the draws present when
              the reveal window closes, and every reveal between now and then moves this line.
            </p>
            {/* The exact 5-column measure is only reachable with a grid, so the
                table semantics are restored by hand rather than lost. */}
            <div className={styles.queueScroll}>
              <div role="table" aria-label="Revealed draws, sorted ascending">
                <div className={`${styles.queueGrid} ${styles.queueHead}`} role="row">
                  <span role="columnheader">#</span>
                  <span role="columnheader">Player</span>
                  <span role="columnheader" className={styles.qHeadNum}>
                    Draw
                  </span>
                  <span role="columnheader" className={styles.qHeadNum}>
                    Would take
                  </span>
                  <span role="columnheader" className={styles.qHeadNum}>
                    Status
                  </span>
                </div>
                {projection.rows.map((row, i) => {
                  const status = projection.stalled ? "held" : row.served ? "served" : "cut";
                  const mine = account !== null && row.player.toLowerCase() === account.toLowerCase();
                  return (
                    <div
                      key={`${row.player}-${i}`}
                      className={`${styles.queueGrid} ${styles.queueRow}`}
                      role="row"
                      data-me={mine}
                      data-state={status}
                    >
                      <span className={styles.qIndex} role="cell">
                        {i + 1}
                      </span>
                      <span className={styles.qPlayer} role="cell">
                        <code className={styles.qCode}>
                          {row.player.slice(0, 6)}…{row.player.slice(-4)}
                        </code>
                        {mine ? <span className={styles.qYou}>you</span> : null}
                      </span>
                      <span className={styles.qNum} role="cell">
                        {(row.draw / 100).toFixed(2)}%
                      </span>
                      <span className={styles.qNum} role="cell" data-struck={status === "cut"}>
                        {fmt(row.wants)}
                      </span>
                      <span className={styles.qStatus} role="cell" data-state={status}>
                        {status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <p className={styles.queueFoot}>
              {projection.stalled ? (
                `Fewer than ${MIN_REVEALS} draws revealed — the whole capacity would carry.`
              ) : (
                <>
                  <strong>{fmt(projection.served)} 0xZAPS</strong> would be delivered,{" "}
                  <strong>{fmt(projection.carry)}</strong> would stay charged for the next round.
                </>
              )}
            </p>
          </section>
        </>
      ) : null}
    </>
  );
}
