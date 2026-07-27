import { describe, expect, it } from "vitest";

import { transactionLifecycleStepStatuses } from "@/lib/transaction-lifecycle";

describe("transaction lifecycle evidence", () => {
  it("keeps an idle recorder neutral", () => {
    expect(transactionLifecycleStepStatuses(null)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("moves from wallet review to an inspectable submitted hash", () => {
    expect(transactionLifecycleStepStatuses("wallet")).toEqual([
      "done",
      "current",
      "pending",
      "pending",
    ]);
    expect(transactionLifecycleStepStatuses("submitted")).toEqual([
      "done",
      "done",
      "done",
      "current",
    ]);
  });

  it("distinguishes confirmation, reversion, and interrupted receipt polling", () => {
    expect(transactionLifecycleStepStatuses("confirmed")).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(transactionLifecycleStepStatuses("reverted")).toEqual([
      "done",
      "done",
      "done",
      "error",
    ]);
    expect(transactionLifecycleStepStatuses("unknown")).toEqual([
      "done",
      "done",
      "done",
      "error",
    ]);
  });

  it("does not imply a hash when the wallet request was rejected", () => {
    expect(transactionLifecycleStepStatuses("not-submitted")).toEqual([
      "done",
      "error",
      "pending",
      "pending",
    ]);
  });
});
