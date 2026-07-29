import type { Address } from "viem";

export function tokenConsoleScope(
  launcher: Address | null,
  token: Address,
) {
  return `${launcher?.toLowerCase() ?? ""}|${token.toLowerCase()}`;
}

export function tokenConsoleSnapshotIsCurrent({
  launcher,
  token,
  loadedScope,
}: {
  launcher: Address | null;
  token: Address;
  loadedScope: string;
}) {
  return launcher !== null && loadedScope === tokenConsoleScope(launcher, token);
}
