import {
  getAddress,
  isAddress,
  parseUnits,
  type Address,
} from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type ParsedFeeShareTransfer =
  | {
      valid: true;
      recipient: Address;
      amount: bigint;
    }
  | {
      valid: false;
      error: string;
    };

export function parseFeeShareTransfer({
  recipient,
  amount,
  balance,
  holder,
}: {
  recipient: string;
  amount: string;
  balance: bigint;
  holder?: Address;
}): ParsedFeeShareTransfer {
  const normalizedRecipient = recipient.trim();
  if (!normalizedRecipient) {
    return { valid: false, error: "Enter a recipient address." };
  }
  if (!isAddress(normalizedRecipient)) {
    return { valid: false, error: "Recipient must be a valid address." };
  }

  const checkedRecipient = getAddress(normalizedRecipient);
  if (checkedRecipient.toLowerCase() === ZERO_ADDRESS) {
    return { valid: false, error: "Fee shares cannot be sent to the zero address." };
  }
  if (
    holder &&
    checkedRecipient.toLowerCase() === holder.toLowerCase()
  ) {
    return { valid: false, error: "Recipient must be a different wallet." };
  }

  const normalizedAmount = amount.trim();
  if (!normalizedAmount) {
    return { valid: false, error: "Enter the number of fee shares to transfer." };
  }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalizedAmount)) {
    return { valid: false, error: "Transfer amount must be a decimal number." };
  }
  if ((normalizedAmount.split(".")[1]?.length ?? 0) > 18) {
    return {
      valid: false,
      error: "Fee shares support up to 18 decimal places.",
    };
  }

  let parsedAmount: bigint;
  try {
    parsedAmount = parseUnits(normalizedAmount, 18);
  } catch {
    return {
      valid: false,
      error: "Fee shares support up to 18 decimal places.",
    };
  }
  if (parsedAmount <= 0n) {
    return { valid: false, error: "Transfer amount must be greater than zero." };
  }
  if (parsedAmount > balance) {
    return { valid: false, error: "Transfer amount exceeds your fee-share balance." };
  }

  return {
    valid: true,
    recipient: checkedRecipient,
    amount: parsedAmount,
  };
}
