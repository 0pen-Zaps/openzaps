import { describe, expect, it } from "vitest";

import { isMotionMode, resolveMotionMode } from "@/lib/motion-preference";

describe("motion preference", () => {
  it("defaults to cinematic motion when the system allows it", () => {
    expect(resolveMotionMode(null, false)).toBe("cinematic");
  });

  it("persists an explicit calm choice", () => {
    expect(resolveMotionMode("calm", false)).toBe("calm");
  });

  it("never lets a cinematic choice override reduced-motion at the OS", () => {
    expect(resolveMotionMode("cinematic", true)).toBe("calm");
  });

  it("accepts only the two persisted values", () => {
    expect(isMotionMode("cinematic")).toBe(true);
    expect(isMotionMode("calm")).toBe(true);
    expect(isMotionMode("full")).toBe(false);
    expect(isMotionMode(null)).toBe(false);
  });
});
