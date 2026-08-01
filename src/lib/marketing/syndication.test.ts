import { describe, expect, it } from "vitest";

import type { SubstackFeedPost } from "@/lib/marketing/channels/substack";
import {
  discoverReviewOnlySyndicationItems,
  normalizeApprovedOpenZapsFeedItems,
  normalizeSubstackFeedPosts,
  SyndicationInputError,
} from "@/lib/marketing/syndication";

const CONFIRMED_URL =
  "https://defitutorials.substack.com/p/give-an-agent-the-trigger-never-the";
const CONFIRMED_TITLE = "Give an Agent the Trigger, Never the Authority";

function post(overrides: Partial<SubstackFeedPost> = {}): SubstackFeedPost {
  return {
    id: "rss-guid-that-is-not-used-for-deduplication",
    title: CONFIRMED_TITLE,
    url: CONFIRMED_URL,
    publishedAt: "2026-07-29T16:55:32.000Z",
    description: "This feed body must never be retained.",
    author: "This author must never be retained.",
    ...overrides,
  };
}

describe("review-only feed syndication", () => {
  it("normalizes only the source-controlled OpenZaps feed as reviewable metadata", () => {
    const items = normalizeApprovedOpenZapsFeedItems();

    expect(items).toHaveLength(4);
    expect(items.every((item) => item.source === "openzaps")).toBe(true);
    expect(items.every((item) => item.classification === "reviewable")).toBe(true);
    expect(items.every((item) => item.draftable)).toBe(true);
    expect(items.every((item) => /^[a-f0-9]{64}$/u.test(item.key))).toBe(true);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
    expect(items[0]).toMatchObject({
      sourceId: "openzaps-virtual-trading-2026-07-30",
      canonicalUrl: "https://www.0xzaps.com/virtual-trading",
    });
    expect(Object.keys(items[0]).sort()).toEqual([
      "attributedUrls",
      "campaignSlug",
      "canonicalUrl",
      "classification",
      "draftable",
      "key",
      "publishedAt",
      "source",
      "sourceId",
      "title",
    ]);
  });

  it("admits an exact manifest URL plus normalized title for review", () => {
    const [item] = normalizeSubstackFeedPosts([
      post({ title: "  Give an Agent the Trigger,   Never the Authority  " }),
    ]);

    expect(item).toMatchObject({
      source: "defitutorials",
      sourceId: "give-an-agent-the-trigger",
      canonicalUrl: CONFIRMED_URL,
      title: CONFIRMED_TITLE,
      publishedAt: "2026-07-29T16:55:32.000Z",
      classification: "reviewable",
      draftable: true,
      campaignSlug:
        "defitutorials-give-an-agent-the-trigger-never-the",
    });
    expect(item).not.toHaveProperty("id");
    expect(item).not.toHaveProperty("description");
    expect(item).not.toHaveProperty("author");
    expect(JSON.stringify(item)).not.toContain("feed body");
  });

  it.each([
    [
      "unlisted canonical URL",
      post({
        id: "unlisted",
        title: "An unclassified public tutorial",
        url: "https://defitutorials.substack.com/p/unclassified-public-tutorial",
      }),
    ],
    [
      "title mismatch",
      post({ title: "A different title for the confirmed URL" }),
    ],
  ])("marks %s as needs_classification and never draftable", (_label, input) => {
    const [item] = normalizeSubstackFeedPosts([input]);

    expect(item.classification).toBe("needs_classification");
    expect(item.draftable).toBe(false);
  });

  it("uses stable URL identity instead of RSS GUID or feed body", () => {
    const first = normalizeSubstackFeedPosts([post()])[0];
    const second = normalizeSubstackFeedPosts([
      post({
        id: "a-provider-reissued-guid",
        description: "Changed RSS summary",
        author: "Changed RSS author",
      }),
    ])[0];

    expect(second.key).toBe(first.key);
    expect(second.campaignSlug).toBe(first.campaignSlug);
    expect(second.attributedUrls).toEqual(first.attributedUrls);
  });

  it("keeps attribution stable when the manifest id differs from the URL slug", () => {
    const confirmed = normalizeSubstackFeedPosts([post()])[0];
    const unclassified = normalizeSubstackFeedPosts([
      post({ title: "A title awaiting manifest approval" }),
    ])[0];

    expect(confirmed.sourceId).toBe("give-an-agent-the-trigger");
    expect(unclassified.sourceId).toBe(
      "give-an-agent-the-trigger-never-the",
    );
    expect(confirmed.key).toBe(unclassified.key);
    expect(confirmed.campaignSlug).toBe(unclassified.campaignSlug);
    expect(confirmed.attributedUrls).toEqual(unclassified.attributedUrls);
  });

  it("adds only stable non-personal X and Discord attribution", () => {
    const [item] = normalizeSubstackFeedPosts([post()]);
    const x = new URL(item.attributedUrls.x);
    const discord = new URL(item.attributedUrls.discord);

    expect(`${x.origin}${x.pathname}`).toBe(CONFIRMED_URL);
    expect(Object.fromEntries(x.searchParams)).toEqual({
      utm_source: "x",
      utm_medium: "social",
      utm_campaign: item.campaignSlug,
      utm_content: "feed_update",
    });
    expect(Object.fromEntries(discord.searchParams)).toEqual({
      utm_source: "discord",
      utm_medium: "community",
      utm_campaign: item.campaignSlug,
      utm_content: "feed_update",
    });
    expect(item.attributedUrls.x).not.toMatch(
      /audience|email|user|wallet|recipient/iu,
    );
  });

  it("deduplicates identical canonical Substack items", () => {
    expect(
      normalizeSubstackFeedPosts([post(), post({ id: "another-guid" })]),
    ).toHaveLength(1);
  });

  it("fails closed on conflicting duplicate metadata", () => {
    expect(() =>
      normalizeSubstackFeedPosts([
        post(),
        post({ id: "another-guid", title: "Conflicting title" }),
      ]),
    ).toThrow(SyndicationInputError);
  });

  it("combines both sources without creating a delivery or queue contract", () => {
    const items = discoverReviewOnlySyndicationItems([post()]);

    expect(items).toHaveLength(5);
    expect(items.filter((item) => item.source === "defitutorials")).toHaveLength(1);
    expect(items.every((item) => !Object.hasOwn(item, "delivery"))).toBe(true);
    expect(items.every((item) => !Object.hasOwn(item, "queue"))).toBe(true);
  });

  it("enforces strict feed, title, URL, and timestamp bounds", () => {
    expect(() => normalizeSubstackFeedPosts(Array.from({ length: 101 }, () => post())))
      .toThrow(/at most 100/u);
    expect(() => normalizeSubstackFeedPosts([post({ title: "x".repeat(201) })]))
      .toThrow(/1-200/u);
    expect(() =>
      normalizeSubstackFeedPosts([
        post({ url: `${CONFIRMED_URL}?utm_source=untrusted` }),
      ]),
    ).toThrow(/canonical/u);
    expect(() =>
      normalizeSubstackFeedPosts([post({ publishedAt: "not-a-date" })]),
    ).toThrow(/valid ISO timestamp/u);
    expect(() =>
      normalizeSubstackFeedPosts([
        post({ title: `Authorization: Bearer ${"a".repeat(32)}` }),
      ]),
    ).toThrow(/credential-like data/u);
    expect(() =>
      normalizeSubstackFeedPosts([
        post({
          title: "Unclassified",
          url: "https://defitutorials.substack.com/p/unclassified",
          publishedAt: "not-a-date",
        }),
      ]),
    ).toThrow(/valid ISO timestamp/u);
  });
});
