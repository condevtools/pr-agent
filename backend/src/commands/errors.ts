export class DurableUnadaptedWriterBlockedError extends Error {
  constructor(readonly platform: "github" | "gitlab", readonly command: string) {
    super(`durable publication blocks unadapted ${platform} writer: ${command}`);
    this.name = "DurableUnadaptedWriterBlockedError";
  }
}
