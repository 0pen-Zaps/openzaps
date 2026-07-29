import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import RoadmapPage from "./page";
import {
  CONTRIBUTION_ALLOCATION,
  FOUNDATION_STATES,
  NON_NEGOTIABLES,
  NORTH_STAR_METRICS,
  ROADMAP_SYSTEMS,
  STATUS_LEGEND,
} from "./roadmap-data";

describe("ecosystem roadmap content", () => {
  it("keeps the eight roadmap systems in their deliberate progression", () => {
    expect(ROADMAP_SYSTEMS.map((system) => system.id)).toEqual([
      "zap-lab",
      "skill-registry",
      "marketplace",
      "contribution-router",
      "productive-uses",
      "agent-league",
      "strategy-engine",
      "seasons",
    ]);
    expect(new Set(ROADMAP_SYSTEMS.map((system) => system.id)).size).toBe(ROADMAP_SYSTEMS.length);
  });

  it("renders systems in the numbered 01 through 08 progression", () => {
    const html = renderToStaticMarkup(createElement(RoadmapPage));
    const renderedNumbers = Array.from(html.matchAll(/data-roadmap-system="(\d{2})"/g), (match) => match[1]);

    expect(renderedNumbers).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
  });

  it("keeps current protocol truth separate from future roadmap statuses", () => {
    expect(FOUNDATION_STATES.some(({ status }) => status.tone === "live")).toBe(true);
    expect(FOUNDATION_STATES.some(({ status }) => status.tone === "experimental")).toBe(true);
    expect(FOUNDATION_STATES.some(({ status }) => status.tone === "gated")).toBe(true);
    expect(FOUNDATION_STATES.some(({ status }) => status.tone === "deferred")).toBe(true);
    expect(STATUS_LEGEND.map(({ tone }) => tone)).toEqual([
      "live",
      "experimental",
      "planned",
      "gated",
      "deferred",
    ]);
  });

  it("keeps the proposed contribution allocation bounded to 100 percent", () => {
    expect(CONTRIBUTION_ALLOCATION.reduce((total, item) => total + item.percentage, 0)).toBe(100);
    expect(CONTRIBUTION_ALLOCATION.map(({ percentage }) => percentage)).toEqual([40, 40, 20]);
  });

  it("retains the safety and measurement contracts", () => {
    expect(NON_NEGOTIABLES).toContain(
      "Every live-capital progression remains capped, reversible, and explicitly authorised by the user.",
    );
    expect(NORTH_STAR_METRICS).toContain("Organic versus incentivised execution volume.");
    expect(NORTH_STAR_METRICS).toHaveLength(9);
  });
});
