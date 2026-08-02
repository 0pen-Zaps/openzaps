import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const source = vi.hoisted(() => {
  class TutorialHandoffSourceError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TutorialHandoffSourceError";
    }
  }
  return {
    ErrorClass: TutorialHandoffSourceError,
    loadHero: vi.fn(),
  };
});

vi.mock("@/lib/marketing/tutorial-handoff-source", () => ({
  TutorialHandoffSourceError: source.ErrorClass,
  loadSourceControlledTutorialHeroAsset: source.loadHero,
}));

import { GET } from "./route";

const TUTORIAL_ID = "paper-trade-first-authority-map";
const HERO_SHA256 = "a".repeat(64);
const HERO_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

function request(token = "operator-token"): Request {
  return new Request(
    `https://www.0xzaps.com/api/marketing/tutorials/${TUTORIAL_ID}/hero`,
    { headers: { authorization: `Bearer ${token}` } },
  );
}

function context(tutorialId = TUTORIAL_ID) {
  return { params: Promise.resolve({ tutorialId }) };
}

beforeEach(() => {
  vi.stubEnv("OPENZAPS_MARKETING_ADMIN_TOKEN", "operator-token");
  source.loadHero.mockReturnValue({
    tutorialId: TUTORIAL_ID,
    fileName: "paper-trade-first.jpg",
    sourcePath: "docs/media/paper-trade-first.jpg",
    sha256: HERO_SHA256,
    mimeType: "image/jpeg",
    width: 1128,
    height: 440,
    byteLength: HERO_BYTES.byteLength,
    alt: "OpenZaps Virtual Trading paper-trading safety preview.",
    bytes: HERO_BYTES,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("source-controlled tutorial hero route", () => {
  it("authenticates before resolving or reading a tutorial asset", async () => {
    const response = await GET(request("wrong-token"), context());

    expect(response.status).toBe(401);
    expect(source.loadHero).not.toHaveBeenCalled();
  });

  it("returns only the exact verified bytes with private attachment headers", async () => {
    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Authorization");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe(
      String(HERO_BYTES.byteLength),
    );
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="openzaps-${TUTORIAL_ID}-hero.jpg"`,
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-openzaps-content-sha256")).toBe(
      HERO_SHA256,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(HERO_BYTES);
    expect(source.loadHero).toHaveBeenCalledWith(TUTORIAL_ID);
  });

  it("fails closed without leaking source details when verification drifts", async () => {
    source.loadHero.mockImplementation(() => {
      throw new source.ErrorClass("private filesystem and hash details");
    });

    const response = await GET(request(), context());
    const raw = await response.text();

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(raw).toContain("no longer matches its reviewed source");
    expect(raw).not.toContain("private filesystem and hash details");
  });

  it("rejects an invalid tutorial id before reading a source-controlled file", async () => {
    const response = await GET(request(), context("../private"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid tutorial selection.",
    });
    expect(source.loadHero).not.toHaveBeenCalled();
  });

  it("returns a retryable generic failure for an unexpected runtime error", async () => {
    source.loadHero.mockImplementation(() => {
      throw new Error("private runtime detail");
    });

    const response = await GET(request(), context());
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(raw).toContain("could not be prepared");
    expect(raw).not.toContain("private runtime detail");
  });
});
