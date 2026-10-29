export class FixStoreError extends Error {
  constructor(readonly code: string) { super(`fix store rejected operation: ${code}`); this.name = "FixStoreError"; }
}
