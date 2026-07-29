import { describe, expect, it } from "vitest";

import { hasLoadedLauncherScope } from "./explore-directory";

describe("ZapPad launch-directory scope", () => {
  it("never treats the unresolved empty runtime scope as a successful read", () => {
    expect(hasLoadedLauncherScope("", "")).toBe(false);
    expect(
      hasLoadedLauncherScope(
        "",
        "0x1111111111111111111111111111111111111111",
      ),
    ).toBe(false);
  });

  it("marks only the exact non-empty launcher scope as loaded", () => {
    const launcher = "0x1111111111111111111111111111111111111111";

    expect(hasLoadedLauncherScope(launcher, launcher)).toBe(true);
    expect(
      hasLoadedLauncherScope(
        launcher,
        "0x2222222222222222222222222222222222222222",
      ),
    ).toBe(false);
  });
});
