import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/zappad/token-console", () => ({
  TokenConsole: () => null,
}));

import { generateMetadata } from "./page";

describe("ZapPad token metadata", () => {
  it("keeps syntactically valid but server-unverified token pages out of indexes", async () => {
    const address = "0x52908400098527886E0F7030069857D2E4169EE7";
    const canonical =
      "https://www.0xzaps.com/launch/token/0x52908400098527886e0f7030069857d2e4169ee7";
    const metadata = await generateMetadata({
      params: Promise.resolve({ address }),
    });

    expect(metadata.title).toContain("Check ZapPad Address");
    expect(metadata.description).toContain("Check whether");
    expect(metadata.alternates?.canonical).toBe(canonical);
    expect(metadata.openGraph?.url).toBe(canonical);
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });
});
