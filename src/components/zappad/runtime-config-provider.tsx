"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RuntimeConfig } from "@/lib/zappad/config";
import {
  LatestRequestGate,
  isSupersededRequest,
} from "@/lib/zappad/latest-request";

interface RuntimeConfigState {
  config: RuntimeConfig | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  verify: () => Promise<RuntimeConfig>;
}

const RuntimeConfigContext = createContext<RuntimeConfigState | null>(null);

async function fetchRuntimeConfig() {
  const response = await fetch("/api/launch/config", {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Runtime configuration is unavailable.");
  }
  return (await response.json()) as RuntimeConfig;
}

export function RuntimeConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGate = useRef(new LatestRequestGate());

  const load = useCallback(async (showLoading: boolean) => {
    const request = requestGate.current.begin();
    if (showLoading) setLoading(true);
    try {
      const next = await request.settle(fetchRuntimeConfig());
      setConfig(next);
      setError(null);
      return next;
    } catch (reason) {
      if (request.isCurrent() && !isSupersededRequest(reason)) {
        setConfig(null);
        setError(
          reason instanceof Error
            ? reason.message
            : "Configuration failed to load.",
        );
      }
      throw reason;
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, []);

  const verify = useCallback(() => load(false), [load]);

  const refresh = useCallback(() => {
    void load(true).catch(() => undefined);
  }, [load]);

  useEffect(() => {
    const gate = requestGate.current;
    const timeout = window.setTimeout(refresh, 0);
    return () => {
      window.clearTimeout(timeout);
      gate.invalidate();
    };
  }, [refresh]);

  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState === "visible") {
        void verify().catch(() => undefined);
      }
    };
    const interval = window.setInterval(revalidate, 30_000);
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [verify]);

  const value = useMemo(
    () => ({ config, loading, error, refresh, verify }),
    [config, loading, error, refresh, verify],
  );

  return (
    <RuntimeConfigContext.Provider value={value}>
      {children}
    </RuntimeConfigContext.Provider>
  );
}

export function useRuntimeConfig() {
  const context = useContext(RuntimeConfigContext);
  if (!context) throw new Error("useRuntimeConfig must be used inside RuntimeConfigProvider.");
  return context;
}
