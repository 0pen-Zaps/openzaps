import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launcher: "0x1111111111111111111111111111111111111111",
  account: "0x2222222222222222222222222222222222222222",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/zappad/wallet", () => ({
  useZapPadWallet: () => ({
    address: mocks.account,
    isConnected: true,
    publicClient: {},
  }),
}));
vi.mock("./runtime-config-provider", () => ({
  useRuntimeConfig: () => ({
    config: {
      launcherAddress: mocks.launcher,
      readEnabled: true,
    },
    loading: false,
  }),
}));
vi.mock("./wallet-button", () => ({
  WalletButton: () => null,
}));

import {
  hasLoadedPortfolioScope,
  PortfolioDashboard,
  portfolioErrorForScope,
} from "./portfolio-dashboard";

describe("ZapPad portfolio scope", () => {
  const { account, launcher } = mocks;

  it("never treats an unresolved launcher or wallet as a successful scan", () => {
    expect(hasLoadedPortfolioScope("", null, null)).toBe(false);
    expect(hasLoadedPortfolioScope("", launcher, null)).toBe(false);
    expect(hasLoadedPortfolioScope("", null, account)).toBe(false);
  });

  it("marks only the exact non-empty launcher and wallet scope as loaded", () => {
    const scope = `${launcher}|${account}`;

    expect(hasLoadedPortfolioScope(scope, launcher, account)).toBe(true);
    expect(
      hasLoadedPortfolioScope(
        scope,
        launcher,
        "0x3333333333333333333333333333333333333333",
      ),
    ).toBe(false);
    expect(
      hasLoadedPortfolioScope(
        scope,
        "0x4444444444444444444444444444444444444444",
        account,
      ),
    ).toBe(false);
  });

  it("does not leak a terminal error into a different wallet or launcher scope", () => {
    const originalScope = `${launcher}|${account}`;
    const error = { scope: originalScope, message: "RPC unavailable" };

    expect(portfolioErrorForScope(error, originalScope)).toBe(
      "RPC unavailable",
    );
    expect(
      portfolioErrorForScope(
        error,
        `${launcher}|0x3333333333333333333333333333333333333333`,
      ),
    ).toBe("");
  });

  it("renders an honest pending state before the first connected-wallet scan", () => {
    const html = renderToStaticMarkup(createElement(PortfolioDashboard));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("skeleton-block");
    expect(html).toContain("Scanning the newest launches");
    expect(html).toContain("Scanning creator history");
    expect(html).not.toContain("No fee rights found");
    expect(html).not.toContain("No creator launches");
    expect(html.match(/<strong>…<\/strong>/g)).toHaveLength(3);
  });
});
