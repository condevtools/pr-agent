export function repositoryReadSignal(parent?: AbortSignal, timeoutMs = 10_000, role?: AbortSignal): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("repository read timeout must be between 100 and 30000ms");
  }
  return AbortSignal.any([parent, role, AbortSignal.timeout(timeoutMs)]
    .filter((value): value is AbortSignal => Boolean(value)));
}
