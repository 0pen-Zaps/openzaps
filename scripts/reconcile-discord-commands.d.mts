export class DiscordCommandReconciliationError extends Error {
  readonly code: string;
}

export interface DiscordCommandDiff {
  readonly inSync: boolean;
  readonly counts: {
    readonly desired: number;
    readonly remote: number;
    readonly create: number;
    readonly update: number;
    readonly delete: number;
  };
  readonly changes: {
    readonly create: readonly string[];
    readonly update: readonly {
      readonly command: string;
      readonly fields: readonly string[];
    }[];
    readonly delete: readonly string[];
  };
}

export interface DiscordCommandReconciliationResult extends DiscordCommandDiff {
  readonly schemaVersion: 1;
  readonly mode: "dry-run" | "apply";
  readonly scope: "guild";
  readonly managedCommandsInSync: boolean;
  readonly applied: boolean;
  readonly verified: boolean;
}

export function validateDesiredCommands(
  value: unknown,
): Array<Record<string, unknown>>;
export function loadDesiredCommands(): Promise<Array<Record<string, unknown>>>;
export function buildCommandDiff(
  desiredValue: unknown,
  remoteValue: unknown,
): DiscordCommandDiff;
export function validateDiscordEnvironment(
  environment: Record<string, string | undefined>,
): { applicationId: string; guildId: string; token: string };
export function parseCliArguments(args: string[]): { apply: boolean };
export function reconcileDiscordCommands(options?: {
  environment?: Record<string, string | undefined>;
  apply?: boolean;
  desiredCommands?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<DiscordCommandReconciliationResult>;
