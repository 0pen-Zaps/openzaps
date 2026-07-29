"use client";

import type { ReactNode } from "react";

import { RuntimeConfigProvider } from "./runtime-config-provider";

/**
 * Feature-local runtime verification only. Wallet state intentionally comes
 * from OpenZaps' root WalletProvider so the shell and signer cannot diverge.
 */
export function ZapPadFeatureProvider({ children }: { children: ReactNode }) {
  return <RuntimeConfigProvider>{children}</RuntimeConfigProvider>;
}
