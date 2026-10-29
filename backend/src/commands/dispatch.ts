export interface CommandDispatchResult {
  ok: boolean;
  message: string;
}

export type CommandHandler = () => Promise<CommandDispatchResult | undefined>;
export interface CommandRegistration<TParsed> {
  name: string;
  parse: () => TParsed | undefined;
  execute: (parsed: TParsed) => Promise<CommandDispatchResult>;
}

export async function dispatchFirstMatchedCommand(
  handlers: readonly CommandHandler[],
  fallback: CommandDispatchResult,
): Promise<CommandDispatchResult> {
  for (const handler of handlers) {
    const result = await handler();
    if (result) {
      return result;
    }
  }
  return fallback;
}

export async function dispatchCommandRegistrations(
  registrations: readonly CommandRegistration<unknown>[],
  fallback: CommandDispatchResult,
): Promise<CommandDispatchResult> {
  for (const registration of registrations) {
    let parsed: unknown;
    try {
      parsed = registration.parse();
    } catch (error) {
      if (typeof console !== "undefined") {
        console.warn(
          `[command-dispatch] parse() threw for command "${registration.name}":`,
          error instanceof Error ? error.message : String(error),
        );
      }
      continue;
    }
    if (typeof parsed === "undefined") {
      continue;
    }
    return registration.execute(parsed);
  }
  return fallback;
}
