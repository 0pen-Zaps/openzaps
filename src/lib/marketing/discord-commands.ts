import commandManifestJson from "./discord-commands.json";

const COMMAND_NAME = /^[a-z0-9_-]{1,32}$/u;
const EXPECTED_COMMAND_NAMES = ["ask", "openzaps", "status"] as const;

export type DiscordCommandName = (typeof EXPECTED_COMMAND_NAMES)[number];

export interface DiscordStringCommandOption {
  readonly name: string;
  readonly description: string;
  readonly type: 3;
  readonly required: boolean;
}

export interface DiscordChatInputCommand {
  readonly name: DiscordCommandName;
  readonly description: string;
  readonly type: 1;
  readonly options?: readonly DiscordStringCommandOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertShortText(
  value: unknown,
  label: string,
  maximum: number,
): asserts value is string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || Array.from(value).length > maximum
  ) {
    throw new Error(`Invalid Discord command manifest ${label}.`);
  }
}

function parseManifest(value: unknown): readonly DiscordChatInputCommand[] {
  if (!Array.isArray(value) || value.length !== EXPECTED_COMMAND_NAMES.length) {
    throw new Error("Invalid Discord command manifest command count.");
  }

  const expectedNames = new Set<string>(EXPECTED_COMMAND_NAMES);
  const seenNames = new Set<string>();
  const parsed = value.map((entry, commandIndex) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid Discord command manifest command ${commandIndex}.`);
    }
    assertShortText(entry.name, `command ${commandIndex} name`, 32);
    if (!COMMAND_NAME.test(entry.name) || !expectedNames.has(entry.name)) {
      throw new Error(`Invalid Discord command manifest command ${commandIndex} name.`);
    }
    if (seenNames.has(entry.name)) {
      throw new Error("Invalid Discord command manifest duplicate command name.");
    }
    seenNames.add(entry.name);
    assertShortText(entry.description, `command ${entry.name} description`, 100);
    if (entry.type !== 1) {
      throw new Error(`Invalid Discord command manifest command ${entry.name} type.`);
    }

    const rawOptions = entry.options ?? [];
    if (!Array.isArray(rawOptions) || rawOptions.length > 25) {
      throw new Error(`Invalid Discord command manifest command ${entry.name} options.`);
    }
    const optionNames = new Set<string>();
    let foundOptional = false;
    const options = rawOptions.map((option, optionIndex) => {
      if (!isRecord(option)) {
        throw new Error(
          `Invalid Discord command manifest command ${entry.name} option ${optionIndex}.`,
        );
      }
      assertShortText(
        option.name,
        `command ${entry.name} option ${optionIndex} name`,
        32,
      );
      if (!COMMAND_NAME.test(option.name) || optionNames.has(option.name)) {
        throw new Error(
          `Invalid Discord command manifest command ${entry.name} option ${optionIndex} name.`,
        );
      }
      optionNames.add(option.name);
      assertShortText(
        option.description,
        `command ${entry.name} option ${option.name} description`,
        100,
      );
      if (option.type !== 3 || typeof option.required !== "boolean") {
        throw new Error(
          `Invalid Discord command manifest command ${entry.name} option ${option.name}.`,
        );
      }
      if (foundOptional && option.required) {
        throw new Error(
          `Invalid Discord command manifest command ${entry.name} option order.`,
        );
      }
      foundOptional ||= !option.required;
      return Object.freeze({
        name: option.name,
        description: option.description,
        type: 3 as const,
        required: option.required,
      });
    });

    return Object.freeze({
      name: entry.name as DiscordCommandName,
      description: entry.description,
      type: 1 as const,
      ...(options.length === 0 ? {} : { options: Object.freeze(options) }),
    });
  });

  if (seenNames.size !== expectedNames.size) {
    throw new Error("Invalid Discord command manifest command names.");
  }
  return Object.freeze(parsed);
}

export const DISCORD_COMMAND_MANIFEST = parseManifest(commandManifestJson);

const supportedCommandNames = new Set<DiscordCommandName>(
  DISCORD_COMMAND_MANIFEST.map((command) => command.name),
);

export function isSupportedDiscordCommandName(
  value: unknown,
): value is DiscordCommandName {
  return (
    typeof value === "string"
    && supportedCommandNames.has(value as DiscordCommandName)
  );
}
