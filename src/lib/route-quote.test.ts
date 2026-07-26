import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type PublicClient } from "viem";

import { OPENZAP_CREATION_FEE } from "@/lib/robinhood";
import { quoteCreationFee } from "@/lib/route-quote";

describe("quoteCreationFee", () => {
  it("quotes the exact creation fee and derives the configured 5% conversion floor", async () => {
    const simulateContract = vi.fn().mockResolvedValue({ result: [2_000_000n, 123_456n] });
    const client = { simulateContract } as unknown as PublicClient;

    const result = await quoteCreationFee(client, zeroAddress);

    expect(result).toEqual({ amountOut: 2_000_000n, minZapsOut: 1_900_000n });
    expect(simulateContract).toHaveBeenCalledTimes(1);
    expect(simulateContract.mock.calls[0]?.[0].args[0].exactAmount).toBe(OPENZAP_CREATION_FEE);
  });

  it("fails closed when the pinned route returns zero", async () => {
    const client = {
      simulateContract: vi.fn().mockResolvedValue({ result: [0n, 123n] }),
    } as unknown as PublicClient;

    await expect(quoteCreationFee(client, zeroAddress)).rejects.toThrow("quotes to zero output");
  });
});
