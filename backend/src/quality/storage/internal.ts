import type { QualityActor, QualityScope } from "./contracts.js";

export const HASH_PATTERN = /^[0-9a-f]{64}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertScope(scope: QualityScope): void {
  if (!UUID_PATTERN.test(scope.tenantId) || !UUID_PATTERN.test(scope.integrationId)) {
    throw new Error("quality scope must contain UUID tenant and integration identifiers");
  }
}

export function assertActor(actor: QualityActor): void {
  if (!["user", "service", "system"].includes(actor.actorType)
      || !actor.actorId || actor.actorId.length > 240) throw new Error("invalid quality actor");
}

export function assertHash(value: string, name: string): void {
  if (!HASH_PATTERN.test(value)) throw new Error(`${name} must be a lowercase SHA-256 hash`);
}

export function assertText(value: string, name: string, max: number): void {
  if (!value || value.length > max) throw new Error(`${name} must be between 1 and ${max} characters`);
}

export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function optionalIso(value: Date | string | null): string | undefined {
  return value === null ? undefined : iso(value);
}

export function safeInteger(value: string | number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}
