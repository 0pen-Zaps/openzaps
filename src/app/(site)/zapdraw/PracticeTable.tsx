"use client";

import { useCallback, useState } from "react";
import { formatUnits } from "viem";

import { BPS, MIN_REVEALS } from "@/lib/overdraw";
import {
  PRACTICE_ENTRY_FEE,
  PRACTICE_PLAYER,
  practiceCapacity,
  practiceCommit,
  practiceNextRound,
  practiceOpenReveals,
  practiceReset,
  practiceReveal,
  practiceSeats,
  practiceSettle,
  practiceStart,
  practiceWillStall,
  type PracticeState,
} from "@/lib/overdraw-practice";
import styles from "./practice.module.css";

/**
 * A ZapDraw table that costs nothing.
 *
 * Same rules, same settlement arithmetic, virtual 0xZAPS. It exists for one
 * reason: the live game has a failure mode — a sealed draw that is never
 * revealed forfeits its entry — that is invisible until it has already taken
 * your money. The first live round ended two seats, zero reveals.
 *
 * So this deliberately lets you skip the reveal and then tells you plainly what
 * it cost. Learning that here is free; learning it on the real table is not.
 */
export function PracticeTable(): React.JSX.Element {
  const [game, setGame] = useState<PracticeState>(() => practiceStart(1));
  const [draw, setDraw] = useState("2500");

  const drawBps = Number.parseInt(draw, 10);
  const drawValid = Number.isInteger(drawBps) && drawBps >= 1 && drawBps <= BPS;
  const capacity = practiceCapacity(game);
  const seats = practiceSeats(game);
  const wouldTake = drawValid ? (capacity * BigInt(drawBps)) / BigInt(BPS) : 0n;

  const fmt = useCallback((v: bigint): string => {
    const n = Number(formatUnits(v, 18));
    if (n === 0) return "0";
    if (n < 0.01) return "<0.01";
    return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }, []);

  const result = game.result;

  return (
    <section className={styles.root} aria-labelledby="practice-heading">
      <div className={styles.head}>
        <div>
          <span className={styles.eyebrow}>PRACTICE TABLE</span>
          <h2 className={styles.title} id="practice-heading">
            Lose a round here instead.
          </h2>
        </div>
        <button type="button" className={styles.reset} onClick={() => setGame(practiceReset(1))}>
          Reset
        </button>
      </div>

      <p className={styles.lede}>
        Same rules and the same settlement maths as the real table, with virtual 0xZAPS. Nothing here touches a
        wallet or the chain. Try skipping the reveal once — that is the mistake worth making for free.
      </p>

      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>Round</dt>
          <dd>{game.round}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Your balance</dt>
          <dd>{fmt(game.balance)}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Seats</dt>
          <dd>{seats}</dd>
        </div>
        <div className={styles.stat}>
          <dt>On the bus</dt>
          <dd>{fmt(capacity)}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Carry pool</dt>
          <dd>{fmt(game.carryPool)}</dd>
        </div>
      </dl>

      {/* ---- commit ---- */}
      {game.phase === "commit" ? (
        <div className={styles.step}>
          {game.seat ? (
            <>
              <p className={styles.note}>
                Seat taken with a draw of <strong>{(game.seat.draw / 100).toFixed(2)}%</strong>. Your entry of{" "}
                {fmt(PRACTICE_ENTRY_FEE)} has already left your balance — that is true on the real table too.
              </p>
              <button type="button" className={styles.primary} onClick={() => setGame(practiceOpenReveals(game))}>
                Close commits →
              </button>
            </>
          ) : (
            <>
              <label className={styles.label} htmlFor="practice-draw">
                Your draw — how much of the bus you claim
              </label>
              <div className={styles.drawRow}>
                <input
                  id="practice-draw"
                  className={styles.range}
                  type="range"
                  min={1}
                  max={BPS}
                  step={25}
                  value={drawValid ? drawBps : 2500}
                  onChange={(e) => setDraw(e.target.value)}
                />
                <output className={styles.drawValue}>{drawValid ? (drawBps / 100).toFixed(2) : "—"}%</output>
              </div>
              <p className={styles.note}>
                That asks for <strong>{fmt(wouldTake)} 0xZAPS</strong>. Small draws are served first, so a modest
                draw is likelier to be paid at all — the bus stops at the first draw it cannot cover in full.
              </p>
              <button
                type="button"
                className={styles.primary}
                disabled={!drawValid || game.balance < PRACTICE_ENTRY_FEE}
                onClick={() => setGame(practiceCommit(game, drawBps))}
              >
                Seal my draw — {fmt(PRACTICE_ENTRY_FEE)} entry
              </button>
            </>
          )}
        </div>
      ) : null}

      {/* ---- reveal ---- */}
      {game.phase === "reveal" ? (
        <div className={styles.step}>
          {!game.seat ? (
            <p className={styles.note}>You sat this round out. Settle it to see how the table paid.</p>
          ) : game.seat.revealed ? (
            <p className={styles.note} data-tone="ok">
              Your draw is open and in the queue.
            </p>
          ) : (
            <p className={styles.note} data-tone="danger">
              <strong>Your seat is still sealed.</strong> If you settle without opening it, the entry is forfeited —
              exactly as the contract does it. Go ahead and try it if you want to see the result.
            </p>
          )}

          {practiceWillStall(game) ? (
            <p className={styles.note} data-tone="warn">
              Fewer than {MIN_REVEALS} draws will be open. The round stalls: the bus pays nobody and the whole
              capacity rolls into the carry pool.
            </p>
          ) : null}

          <div className={styles.actions}>
            {game.seat && !game.seat.revealed ? (
              <button type="button" className={styles.primary} onClick={() => setGame(practiceReveal(game))}>
                Open my draw
              </button>
            ) : null}
            <button type="button" className={styles.secondary} onClick={() => setGame(practiceSettle(game))}>
              Settle the round →
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- result ---- */}
      {game.phase === "settled" && result ? (
        <div className={styles.step}>
          {result.forfeited ? (
            <p className={styles.note} data-tone="danger">
              <strong>You forfeited {fmt(PRACTICE_ENTRY_FEE)} 0xZAPS.</strong> Your seat was never opened, so the
              settlement did not see your draw at all and your entry went to the carry pool. On the real table this
              is final — there is no refund and no way to reveal late. It is what happened to both players in the
              live game&apos;s first round.
              {result.stalled ? (
                <>
                  {" "}
                  This round also stalled — fewer than {MIN_REVEALS} draws were opened in total, so opening yours
                  would not have paid you either. Two separate ways to lose the same entry, and they compound.
                </>
              ) : null}
            </p>
          ) : result.stalled ? (
            <p className={styles.note} data-tone="warn">
              The round stalled — fewer than {MIN_REVEALS} draws were opened, so the bus paid nobody and{" "}
              {fmt(result.capacity)} rolled into the carry pool. Your entry is gone even though you did everything
              right; a table this thin cannot discharge.
            </p>
          ) : result.paid > 0n ? (
            <p className={styles.note} data-tone="ok">
              <strong>Paid {fmt(result.paid)} 0xZAPS.</strong> Your draw was small enough that the bus still had
              capacity when it reached you.
            </p>
          ) : (
            <p className={styles.note} data-tone="warn">
              The bus ran dry before it reached your draw, so you were paid nothing. Draws are served smallest
              first — a smaller draw would have been served, for less.
            </p>
          )}

          <table className={styles.table}>
            <caption className={styles.caption}>Settlement, smallest draw first</caption>
            <thead>
              <tr>
                <th scope="col">Draw</th>
                <th scope="col">Asked</th>
                <th scope="col">Paid</th>
              </tr>
            </thead>
            <tbody>
              {result.waterfall.rows.map((row, i) => (
                <tr key={`${row.player}-${i}`} data-you={row.player === PRACTICE_PLAYER || undefined}>
                  <td>
                    {(row.draw / 100).toFixed(2)}%{row.player === PRACTICE_PLAYER ? " — you" : ""}
                  </td>
                  <td>{fmt(row.wants)}</td>
                  <td data-served={row.served || undefined}>{row.served ? fmt(row.paid) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <button type="button" className={styles.primary} onClick={() => setGame(practiceNextRound(game))}>
            Next round →
          </button>
        </div>
      ) : null}
    </section>
  );
}
