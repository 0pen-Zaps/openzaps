import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress, type Address } from "viem";

export interface ZapPadE2eRunState {
  baseUrl: string;
  rpcUrl: string;
  chainId: number;
  forkBlock: number;
  deployBlock: number;
  launcher: Address;
  accounts: {
    creator: Address;
    recipient: Address;
    treasury: Address;
    trader: Address;
  };
  contracts: {
    weth: Address;
    usdg: Address;
    positionManager: Address;
    swapRouter: Address;
  };
  fundedUsdg: string;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid E2E run state field: ${field}`);
  }
  return value;
}

function requireInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid E2E run state field: ${field}`);
  }
  return Number(value);
}

function address(value: unknown, field: string) {
  return getAddress(requireString(value, field));
}

export async function loadRunState(): Promise<ZapPadE2eRunState> {
  const statePath = process.env.ZAPPAD_E2E_RUN_STATE;
  if (!statePath) {
    throw new Error(
      "ZAPPAD_E2E_RUN_STATE is missing. Run `npm run test:zappad:e2e:fork`.",
    );
  }

  const parsed = JSON.parse(
    await readFile(resolve(statePath), "utf8"),
  ) as Record<string, unknown>;
  const accounts = parsed.accounts as Record<string, unknown> | undefined;
  const contracts = parsed.contracts as Record<string, unknown> | undefined;
  if (!accounts || !contracts) throw new Error("Incomplete E2E run state.");

  const baseUrl = requireString(parsed.baseUrl, "baseUrl");
  const rpcUrl = requireString(parsed.rpcUrl, "rpcUrl");
  const base = new URL(baseUrl);
  const rpc = new URL(rpcUrl);
  if (
    base.protocol !== "http:" ||
    rpc.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(base.hostname) ||
    !["127.0.0.1", "localhost"].includes(rpc.hostname)
  ) {
    throw new Error("E2E browser and wallet endpoints must remain on loopback.");
  }

  return {
    baseUrl: base.toString().replace(/\/$/, ""),
    rpcUrl: rpc.toString(),
    chainId: requireInteger(parsed.chainId, "chainId"),
    forkBlock: requireInteger(parsed.forkBlock, "forkBlock"),
    deployBlock: requireInteger(parsed.deployBlock, "deployBlock"),
    launcher: address(parsed.launcher, "launcher"),
    accounts: {
      creator: address(accounts.creator, "accounts.creator"),
      recipient: address(accounts.recipient, "accounts.recipient"),
      treasury: address(accounts.treasury, "accounts.treasury"),
      trader: address(accounts.trader, "accounts.trader"),
    },
    contracts: {
      weth: address(contracts.weth, "contracts.weth"),
      usdg: address(contracts.usdg, "contracts.usdg"),
      positionManager: address(
        contracts.positionManager,
        "contracts.positionManager",
      ),
      swapRouter: address(contracts.swapRouter, "contracts.swapRouter"),
    },
    fundedUsdg: requireString(parsed.fundedUsdg, "fundedUsdg"),
  };
}
