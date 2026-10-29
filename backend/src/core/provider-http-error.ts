/** Preserve HTTP classification without exposing response bodies or credentials. */
export class ProviderHttpError extends Error {
  constructor(provider: string, readonly status: number) {
    super(`${provider} HTTP request failed (${status})`);
    this.name = "ProviderHttpError";
  }
}
