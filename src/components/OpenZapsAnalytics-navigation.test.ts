import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { effectHarness, routeState, track } = vi.hoisted(() => {
  const effectDeps: Array<readonly unknown[] | undefined> = [];
  const effectCleanups: Array<(() => void) | undefined> = [];
  let hookIndex = 0;

  return {
    routeState: { pathname: "/request-a-zap", search: "" },
    track: vi.fn(),
    effectHarness: {
      beginRender: () => {
        hookIndex = 0;
      },
      reset: () => {
        effectCleanups.forEach((cleanup) => cleanup?.());
        effectDeps.length = 0;
        effectCleanups.length = 0;
        hookIndex = 0;
      },
      useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
        const index = hookIndex;
        hookIndex += 1;
        const previous = effectDeps[index];
        const changed =
          previous === undefined
          || deps === undefined
          || previous.length !== deps.length
          || deps.some((value, dependencyIndex) => !Object.is(value, previous[dependencyIndex]));

        if (!changed) return;
        effectCleanups[index]?.();
        effectDeps[index] = deps;
        effectCleanups[index] = effect() ?? undefined;
      },
    },
  };
});

vi.mock("react", () => ({ useEffect: effectHarness.useEffect }));
vi.mock("next/navigation", () => ({
  usePathname: () => routeState.pathname,
  useSearchParams: () => new URLSearchParams(routeState.search),
}));
vi.mock("@vercel/analytics", () => ({ track }));
vi.mock("@vercel/analytics/next", () => ({ Analytics: () => null }));

import { OpenZapsAnalytics } from "@/components/OpenZapsAnalytics";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

function renderAnalytics(): void {
  effectHarness.beginRender();
  OpenZapsAnalytics();
}

describe("OpenZaps analytics navigation tracking", () => {
  beforeEach(() => {
    routeState.pathname = "/request-a-zap";
    routeState.search = "";
    track.mockReset();
    effectHarness.reset();

    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      dispatchEvent: vi.fn(),
      location: routeState,
      sessionStorage: memoryStorage(),
    });
    vi.stubGlobal(
      "CustomEvent",
      class TestCustomEvent {
        constructor(
          public type: string,
          public init: { detail: unknown },
        ) {}
      },
    );
  });

  afterEach(() => {
    effectHarness.reset();
    vi.unstubAllGlobals();
  });

  it("records an owned UTM that arrives on the same pathname exactly once", () => {
    renderAnalytics();
    expect(track).not.toHaveBeenCalled();

    routeState.search = "utm_source=openzaps&utm_medium=website&utm_campaign=request_a_zap&utm_content=learn_hub";
    renderAnalytics();
    renderAnalytics();

    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith("campaign_arrival", {
      acquisition: "openzaps|website|request_a_zap|learn_hub",
    });
  });

  it("records an owned UTM after a cross-path App Router transition", () => {
    routeState.pathname = "/learn";
    renderAnalytics();

    routeState.pathname = "/request-a-zap";
    routeState.search = "utm_source=openzaps&utm_medium=website&utm_campaign=request_a_zap&utm_content=learn_hub";
    renderAnalytics();

    expect(track).toHaveBeenCalledOnce();
  });
});
