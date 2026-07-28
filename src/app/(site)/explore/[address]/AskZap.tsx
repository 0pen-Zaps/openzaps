"use client";

import { useCallback, useMemo, useState } from "react";
import type { Address } from "viem";

import { Transcript } from "@/components/Transcript";
import {
  transcriptId,
  type TranscriptChip,
  type TranscriptFactRow,
  type TranscriptMessage,
  type TranscriptStatus,
} from "@/lib/transcript";
import styles from "./ask.module.css";

/**
 * Ask a question about this capsule.
 *
 * Kept out of ZapLive deliberately: that component holds one block-pinned snapshot and every
 * reading in it comes from the same block. This asks a separate question of a separate endpoint,
 * and folding it in would blur which numbers came from the pinned read.
 *
 * The answers are grounded server-side — the model may only cite fields the route actually built,
 * and cited values are re-read from the payload rather than trusted from the prose. When no model
 * is configured, the same endpoint returns the facts alone, so this panel degrades into a
 * capsule-facts reader instead of breaking.
 */

const SUGGESTED: readonly TranscriptChip[] = [
  { id: "q-bounds", label: "What can this actually spend?", value: "What can this capsule actually spend, and where does it pay out?" },
  { id: "q-integrity", label: "Does it verify?", value: "Do all its integrity checks hold? List anything that does not." },
  { id: "q-history", label: "What has it done?", value: "What has this capsule done so far?" },
];

export function AskZap({ address }: { address: Address }): React.JSX.Element {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [status, setStatus] = useState<TranscriptStatus>("idle");
  const [note, setNote] = useState<string | undefined>(undefined);

  const ask = useCallback(
    async (question: string): Promise<void> => {
      const asked: TranscriptMessage = {
        id: transcriptId("ask", Date.now()),
        role: "you",
        body: { kind: "text", text: question },
      };
      setMessages((current) => [...current, asked]);
      setStatus("thinking");
      setNote(undefined);

      try {
        const response = await fetch("/api/agent/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ zap: address, question }),
        });
        const body = (await response.json()) as
          | { ok: true; answer: string; cited: TranscriptFactRow[] }
          | { ok: false; error: string };

        if (!body.ok) {
          setStatus("error");
          setNote(body.error);
          return;
        }

        setMessages((current) => [
          ...current,
          { id: `${asked.id}-a`, role: "agent", body: { kind: "text", text: body.answer } },
          // The cited facts are rendered as a capsule message with values read
          // from the payload — the model formats, the app supplies the numbers.
          ...(body.cited.length > 0
            ? [
                {
                  id: `${asked.id}-f`,
                  role: "capsule" as const,
                  body: { kind: "facts" as const, rows: body.cited },
                },
              ]
            : []),
        ]);
        setStatus("idle");
      } catch {
        setStatus("error");
        setNote("The capsule reader could not be reached.");
      }
    },
    [address],
  );

  const composer = useMemo(
    () => ({
      mode: "text" as const,
      placeholder: "Ask about this capsule",
      maxLength: 300,
      busy: status === "thinking",
      chips: messages.length === 0 ? [...SUGGESTED] : undefined,
    }),
    [status, messages.length],
  );

  return (
    <section className={styles.card} aria-labelledby="ask-heading">
      <div className={styles.head}>
        <h2 className={styles.title} id="ask-heading">
          Ask this capsule
        </h2>
        <span className={styles.sub}>answers cite the fields they rest on</span>
      </div>
      <p className={styles.body}>
        Questions are answered only from what this capsule reports onchain. Any figure that does not
        appear in its own record is refused rather than guessed at.
      </p>
      <Transcript
        label="Capsule questions"
        messages={messages}
        status={status}
        statusNote={note}
        composer={composer}
        onChip={(chip) => void ask(chip.value)}
        onSubmit={(text) => void ask(text)}
      />
    </section>
  );
}
