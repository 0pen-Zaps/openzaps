"use client";

import { useEffect, useState } from "react";
import {
  MOTION_STORAGE_KEY,
  REDUCED_MOTION_QUERY,
  saveMotionMode,
  syncMotionMode,
} from "@/lib/motion-preference";
import { useReducedMotionPreference } from "@/components/useReducedMotionPreference";

export function MotionControl(): React.JSX.Element {
  const reduced = useReducedMotionPreference();
  // Calm is the safe server/hydration snapshot. The effect replaces it with the
  // real media-query value immediately after mount.
  const [systemReduced, setSystemReduced] = useState(true);

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = (): void => {
      setSystemReduced(media.matches);
      syncMotionMode();
    };
    update();
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === MOTION_STORAGE_KEY) update();
    };
    media.addEventListener("change", update);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const label = systemReduced
    ? "Calm motion follows your system setting"
    : reduced
      ? "Use cinematic motion"
      : "Use calm motion";

  return (
    <button
      type="button"
      className="motionControl"
      data-mode={reduced ? "calm" : "cinematic"}
      aria-label={label}
      aria-pressed={reduced}
      disabled={systemReduced}
      title={label}
      onClick={() => saveMotionMode(reduced ? "cinematic" : "calm")}
    >
      <span className="motionControlIcon" aria-hidden="true">
        {reduced ? "❚❚" : "▶"}
      </span>
      <span>{systemReduced ? "SYSTEM CALM" : reduced ? "CALM" : "CINEMATIC"}</span>
    </button>
  );
}
