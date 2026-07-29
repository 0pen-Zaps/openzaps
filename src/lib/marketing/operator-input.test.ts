import { describe, expect, it } from "vitest";

import {
  marketingRunIdFromSearch,
  parseMarketingSourceUrls,
} from "@/lib/marketing/operator-input";

describe("marketing operator inputs", () => {
  it("normalizes HTTPS source URLs and rejects every other scheme", () => {
    expect(
      parseMarketingSourceUrls(
        " https://www.0xzaps.com/docs \nhttps://github.com/0pen-Zaps/openzaps",
      ),
    ).toEqual([
      "https://www.0xzaps.com/docs",
      "https://github.com/0pen-Zaps/openzaps",
    ]);

    expect(() => parseMarketingSourceUrls("http://www.0xzaps.com/docs")).toThrow(
      "Source URLs must use https.",
    );
    expect(() => parseMarketingSourceUrls("javascript:alert(1)")).toThrow(
      "Source URLs must use https.",
    );
    expect(() => parseMarketingSourceUrls("https://attacker.example/prompt")).toThrow(
      "Source URL is outside the reviewed OpenZaps origins.",
    );
    expect(() => parseMarketingSourceUrls("https://secret@www.0xzaps.com/docs")).toThrow(
      "Source URL is outside the reviewed OpenZaps origins.",
    );
  });

  it("strips non-evidence fragments and rejects credential-like URL metadata", () => {
    const credentialLikeValue = [
      "abcdefgh",
      "ijklmnop",
      "qrstuvwx",
      "yz123456",
    ].join("");

    expect(
      parseMarketingSourceUrls(
        "https://www.0xzaps.com/docs?view=security#current-gates",
      ),
    ).toEqual(["https://www.0xzaps.com/docs?view=security"]);

    for (const source of [
      `https://www.0xzaps.com/docs?access_token=${credentialLikeValue}`,
      `https://github.com/0pen-Zaps/openzaps?utm_content=sk-proj-${"a".repeat(40)}`,
      `https://defitutorials.substack.com/#authorization=Bearer%20${credentialLikeValue}`,
    ]) {
      expect(() => parseMarketingSourceUrls(source), source).toThrow(
        "appears to contain a credential",
      );
    }
  });

  it("reads only a bounded path-safe run id from review links", () => {
    expect(marketingRunIdFromSearch("?run=wrun_01ABC&token=never-read")).toBe("wrun_01ABC");
    expect(marketingRunIdFromSearch("?run=has%2Fslash")).toBe("");
    expect(marketingRunIdFromSearch(`?run=${"x".repeat(201)}`)).toBe("");
    expect(marketingRunIdFromSearch("?token=secret-only")).toBe("");
  });
});
