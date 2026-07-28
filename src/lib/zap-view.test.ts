import { describe, expect, it } from "vitest";

import { DEFAULT_ZAP_VIEW, ZAP_VIEWS, impliedZapView, resolveZapView } from "@/lib/zap-view";

const view = (query: string) => impliedZapView(new URLSearchParams(query));
const resolved = (query: string) => resolveZapView(new URLSearchParams(query));

describe("impliedZapView", () => {
  it("answers every explicit view", () => {
    for (const name of ZAP_VIEWS) {
      expect(view(`view=${name}`)).toBe(name);
    }
  });

  it("is silent on an empty or unknown query", () => {
    expect(view("")).toBeNull();
    expect(view("view=nonsense")).toBeNull();
    expect(view("foo=bar")).toBeNull();
  });

  it("keeps the inference rules that predate the redesign", () => {
    // These appear in old bookmarks and in the /build and /app redirects.
    expect(view("src=build")).toBe("sign");
    expect(view("route=zaps-buy")).toBe("sign");
    expect(view("d=abc123")).toBe("design");
  });

  it("prefers an explicit view over every inference rule", () => {
    // The ordering trap: `?view=connect&src=build` is the exact shape a handoff
    // produces. If the explicit check sat below the `src=build` rule this would
    // resolve to "sign" with no error — the wrong screen, silently.
    expect(view("view=connect&src=build")).toBe("connect");
    expect(view("view=connect&route=zaps-buy")).toBe("connect");
    expect(view("view=connect&d=abc123")).toBe("connect");
    expect(view("view=automate&src=build")).toBe("automate");
    expect(view("view=design&src=build")).toBe("design");
    expect(view("view=start&d=abc123")).toBe("start");
  });

  it("resolves src=build before d= when both are present", () => {
    expect(view("src=build&d=abc123")).toBe("sign");
  });
});

describe("resolveZapView", () => {
  it("falls back to the default when the URL is silent", () => {
    expect(resolved("")).toBe(DEFAULT_ZAP_VIEW);
    expect(resolved("view=nonsense")).toBe(DEFAULT_ZAP_VIEW);
  });

  it("passes every explicit view through", () => {
    for (const name of ZAP_VIEWS) {
      expect(resolved(`view=${name}`)).toBe(name);
    }
  });
});

describe("the view list", () => {
  it("has no duplicates and contains the default", () => {
    expect(new Set(ZAP_VIEWS).size).toBe(ZAP_VIEWS.length);
    expect(ZAP_VIEWS).toContain(DEFAULT_ZAP_VIEW);
  });
});
