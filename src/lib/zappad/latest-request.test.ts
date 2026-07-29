import { describe, expect, it } from "vitest";
import {
  LatestRequestGate,
  SupersededRequestError,
} from "./latest-request";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("latest request gate", () => {
  it("rejects an older deferred response after a newer response becomes authoritative", async () => {
    const gate = new LatestRequestGate();
    const olderResponse = deferred<{ launchEnabled: boolean }>();
    const newerResponse = deferred<{ launchEnabled: boolean }>();
    const older = gate.begin().settle(olderResponse.promise);
    const newer = gate.begin().settle(newerResponse.promise);

    newerResponse.resolve({ launchEnabled: false });
    await expect(newer).resolves.toEqual({ launchEnabled: false });

    olderResponse.resolve({ launchEnabled: true });
    await expect(older).rejects.toBeInstanceOf(SupersededRequestError);
  });

  it("rejects a response after the consuming scope is invalidated", async () => {
    const gate = new LatestRequestGate();
    const response = deferred<string>();
    const pending = gate.begin().settle(response.promise);

    gate.invalidate();
    response.resolve("stale");

    await expect(pending).rejects.toBeInstanceOf(SupersededRequestError);
  });
});
