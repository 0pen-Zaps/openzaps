import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import {
  hasPreparedExecutionSuccess,
  SAFE_ABI,
} from "./safe-canary-receipts.mjs";

const SAFE = "0x1111111111111111111111111111111111111111";
const SAFE_TRANSACTION_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function executionSuccessLog(hash = SAFE_TRANSACTION_HASH) {
  return {
    address: SAFE,
    data: encodeAbiParameters([{ type: "uint256" }], [0n]),
    topics: encodeEventTopics({
      abi: SAFE_ABI,
      eventName: "ExecutionSuccess",
      args: { txHash: hash },
    }),
  };
}

describe("Safe canary receipt event verification", () => {
  it("accepts the canonical indexed Safe v1.4.1 ExecutionSuccess event", () => {
    expect(
      hasPreparedExecutionSuccess(
        [executionSuccessLog()],
        SAFE,
        SAFE_TRANSACTION_HASH,
      ),
    ).toBe(true);
  });

  it("rejects a different Safe transaction hash", () => {
    expect(
      hasPreparedExecutionSuccess(
        [executionSuccessLog()],
        SAFE,
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
    ).toBe(false);
  });
});
