import { decodeEventLog, getAddress, parseAbi } from "viem";

export const SAFE_ABI = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
]);

export function hasPreparedExecutionSuccess(logs, safe, safeTransactionHash) {
  const expectedSafe = getAddress(safe);
  const expectedHash = safeTransactionHash.toLowerCase();

  for (const log of logs) {
    if (getAddress(log.address) !== expectedSafe) continue;
    try {
      const event = decodeEventLog({
        abi: SAFE_ABI,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (
        event.eventName === "ExecutionSuccess" &&
        event.args.txHash.toLowerCase() === expectedHash
      ) {
        return true;
      }
    } catch {
      // Ignore unrelated Safe logs.
    }
  }
  return false;
}
