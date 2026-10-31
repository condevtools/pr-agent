import type { PoolClient } from "pg";

import type { RuntimeDatabase } from "../../agent-runtime/postgres/database.js";
import { MANAGED_PROMPT_CATALOG } from "../prompts/catalog.js";
import { MANAGED_PROMPT_KEYS, promptBundleHash, promptTemplateHash, promptTemplateVariables,
  type ManagedPromptKey, type PromptBundleV1 } from "../prompts/contracts.js";
import type { ImportQualityPromptInput, QualityActor, QualityPromptStatus,
  QualityPromptVersion, QualityScope } from "./contracts.js";
import { QualityStorageConflictError, QualityStorageNotFoundError } from "./contracts.js";
import { assertActor, assertHash, assertScope, assertText, iso, optionalIso, safeInteger } from "./internal.js";

interface PromptRow {
  id: string; tenant_id: string; integration_id: string; prompt_key: string;
  remote_prompt_name: string; remote_prompt_version: number; template_json: unknown; content_hash: string;
  variables: string[]; source_fingerprint: string; target_fingerprint: string; status: QualityPromptStatus;
  imported_by_actor_type: QualityActor["actorType"]; imported_by_actor_id: string;
  activation_command_key: string | null; approved_by_actor_type: QualityActor["actorType"] | null;
  approved_by_actor_id: string | null; approved_at: Date | null; retired_at: Date | null;
  created_at: Date; updated_at: Date; version: string;
}

export class PgQualityPromptStore {
  constructor(private readonly db: RuntimeDatabase) {}

  async importCandidate(scope: QualityScope, input: ImportQualityPromptInput): Promise<QualityPromptVersion> {
    validateImport(scope, input);
    return this.db.transaction(scope.tenantId, async (client) => {
      const inserted = await client.query<PromptRow>(
        `INSERT INTO pr_agent_harness.quality_prompt_versions
           (tenant_id,integration_id,prompt_key,remote_prompt_name,remote_prompt_version,template_json,
            content_hash,variables,source_fingerprint,target_fingerprint,imported_by_actor_type,imported_by_actor_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::text[],$9,$10,$11,$12)
         ON CONFLICT (tenant_id,integration_id,prompt_key,remote_prompt_name,remote_prompt_version)
         DO NOTHING RETURNING *`,
        [scope.tenantId, scope.integrationId, input.promptKey, input.remotePromptName, input.remotePromptVersion,
          JSON.stringify(input.template), input.contentHash, normalizedVariables(input.variables),
          input.sourceFingerprint, input.targetFingerprint, input.actor.actorType, input.actor.actorId]);
      if (inserted.rows[0]) return mapPrompt(inserted.rows[0]);
      const existing = await client.query<PromptRow>(
        `SELECT * FROM pr_agent_harness.quality_prompt_versions
         WHERE tenant_id=$1 AND integration_id=$2 AND prompt_key=$3
           AND remote_prompt_name=$4 AND remote_prompt_version=$5`,
        [scope.tenantId, scope.integrationId, input.promptKey, input.remotePromptName, input.remotePromptVersion]);
      const row = existing.rows[0];
      if (!row || row.content_hash !== input.contentHash || row.source_fingerprint !== input.sourceFingerprint
          || row.target_fingerprint !== input.targetFingerprint || row.template_json !== input.template
          || !same(row.variables, normalizedVariables(input.variables))) {
        throw new QualityStorageConflictError("Remote prompt version identity was reused with different content");
      }
      return mapPrompt(row);
    });
  }

  async list(scope: QualityScope, filter: { promptKey?: ManagedPromptKey; status?: QualityPromptStatus } = {}): Promise<QualityPromptVersion[]> {
    assertScope(scope);
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<PromptRow>(
        `SELECT * FROM pr_agent_harness.quality_prompt_versions
         WHERE tenant_id=$1 AND integration_id=$2
           AND ($3::text IS NULL OR prompt_key=$3) AND ($4::text IS NULL OR status=$4)
         ORDER BY prompt_key,remote_prompt_version DESC,id`,
        [scope.tenantId, scope.integrationId, filter.promptKey ?? null, filter.status ?? null]);
      return result.rows.map(mapPrompt);
    });
  }

  async activate(scope: QualityScope, input: { promptVersionId: string; promptKey: ManagedPromptKey;
    expectedContentHash: string; expectedSourceFingerprint: string; targetFingerprint: string;
    commandKey: string; actor: QualityActor }): Promise<QualityPromptVersion> {
    assertScope(scope); assertActor(input.actor); assertText(input.commandKey, "activation command key", 240);
    assertHash(input.expectedContentHash, "expected content hash");
    assertHash(input.expectedSourceFingerprint, "expected source fingerprint");
    assertHash(input.targetFingerprint, "target fingerprint");
    return this.db.transaction(scope.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,934))", [
        `${scope.tenantId}:${scope.integrationId}:${input.promptKey}`,
      ]);
      const replay = await client.query<PromptRow>(
        `SELECT * FROM pr_agent_harness.quality_prompt_versions
         WHERE tenant_id=$1 AND integration_id=$2 AND activation_command_key=$3 FOR UPDATE`,
        [scope.tenantId, scope.integrationId, input.commandKey]);
      if (replay.rows[0]) {
        const row = replay.rows[0];
        if (row.id !== input.promptVersionId || row.prompt_key !== input.promptKey
            || row.content_hash !== input.expectedContentHash
            || row.source_fingerprint !== input.expectedSourceFingerprint
            || row.target_fingerprint !== input.targetFingerprint
            || row.approved_by_actor_type !== input.actor.actorType
            || row.approved_by_actor_id !== input.actor.actorId) {
          throw new QualityStorageConflictError("Prompt activation command was reused with different content");
        }
        return mapPrompt(row);
      }
      const selected = await client.query<PromptRow>(
        `SELECT * FROM pr_agent_harness.quality_prompt_versions
         WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 FOR UPDATE`,
        [scope.tenantId, scope.integrationId, input.promptVersionId]);
      const row = selected.rows[0];
      if (!row) throw new QualityStorageNotFoundError("Prompt candidate was not found");
      if (row.status !== "candidate" || row.prompt_key !== input.promptKey
          || row.content_hash !== input.expectedContentHash
          || row.source_fingerprint !== input.expectedSourceFingerprint
          || row.target_fingerprint !== input.targetFingerprint) {
        throw new QualityStorageConflictError("Prompt candidate no longer matches the approved source and target");
      }
      assertPromptVariableAbi(input.promptKey, row.template_json, row.variables);
      await client.query(
        `UPDATE pr_agent_harness.quality_prompt_versions SET status='retired',retired_at=clock_timestamp(),
           updated_at=clock_timestamp(),version=version+1
         WHERE tenant_id=$1 AND integration_id=$2 AND prompt_key=$3 AND status='active'`,
        [scope.tenantId, scope.integrationId, input.promptKey]);
      const activated = await client.query<PromptRow>(
        `UPDATE pr_agent_harness.quality_prompt_versions SET status='active',activation_command_key=$4,
           approved_by_actor_type=$5,approved_by_actor_id=$6,approved_at=clock_timestamp(),retired_at=NULL,
           updated_at=clock_timestamp(),version=version+1
         WHERE tenant_id=$1 AND integration_id=$2 AND id=$3 AND status='candidate' RETURNING *`,
        [scope.tenantId, scope.integrationId, input.promptVersionId, input.commandKey,
          input.actor.actorType, input.actor.actorId]);
      if (!activated.rows[0]) throw new QualityStorageConflictError("Prompt activation lost its candidate CAS");
      return mapPrompt(activated.rows[0]);
    });
  }

  async purgeInactive(scope: QualityScope, input: { before: Date; limit?: number }): Promise<number> {
    assertScope(scope); const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000 || !Number.isFinite(input.before.getTime())) {
      throw new Error("invalid prompt retention request");
    }
    return this.db.transaction(scope.tenantId, async (client) => {
      const result = await client.query<{ count: number }>(
        `WITH candidates AS (
           SELECT id FROM pr_agent_harness.quality_prompt_versions
           WHERE tenant_id=$1 AND integration_id=$2 AND status IN ('candidate','retired')
             AND updated_at<$3 ORDER BY updated_at,id LIMIT $4
         ), deleted AS (
           DELETE FROM pr_agent_harness.quality_prompt_versions p USING candidates c WHERE p.id=c.id RETURNING 1
         ) SELECT count(*)::int AS count FROM deleted`, [scope.tenantId, scope.integrationId, input.before, limit]);
      return result.rows[0]?.count ?? 0;
    });
  }
}

export async function freezePromptBundleInTransaction(client: PoolClient, tenantId: string,
  integrationId: string, targetFingerprint: string): Promise<PromptBundleV1> {
  assertScope({ tenantId, integrationId }); assertHash(targetFingerprint, "target fingerprint");
  const result = await client.query<PromptRow>(
    `SELECT * FROM pr_agent_harness.quality_prompt_versions
     WHERE tenant_id=$1 AND integration_id=$2 AND status='active' ORDER BY prompt_key`,
    [tenantId, integrationId]);
  const prompts: PromptBundleV1["prompts"] = {};
  for (const row of result.rows) {
    if (row.target_fingerprint !== targetFingerprint) {
      throw new QualityStorageConflictError(`Active prompt target is stale: ${row.prompt_key}`);
    }
    if (!MANAGED_PROMPT_KEYS.includes(row.prompt_key as ManagedPromptKey) || typeof row.template_json !== "string") {
      throw new QualityStorageConflictError(`Active prompt payload is invalid: ${row.prompt_key}`);
    }
    const key = row.prompt_key as ManagedPromptKey;
    assertPromptVariableAbi(key, row.template_json, row.variables);
    prompts[key] = { key, name: row.remote_prompt_name, version: row.remote_prompt_version,
      template: row.template_json, contentHash: row.content_hash, variables: row.variables,
      targetFingerprint: row.target_fingerprint };
  }
  return { schemaVersion: 1, targetFingerprint, prompts, hash: promptBundleHash(targetFingerprint, prompts) };
}

function validateImport(scope: QualityScope, input: ImportQualityPromptInput): void {
  assertScope(scope); assertActor(input.actor);
  if (!MANAGED_PROMPT_KEYS.includes(input.promptKey as ManagedPromptKey)) throw new Error("unmanaged prompt key");
  assertText(input.remotePromptName, "remote prompt name", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(input.remotePromptName)) {
    throw new Error("invalid remote prompt name");
  }
  if (!Number.isSafeInteger(input.remotePromptVersion) || input.remotePromptVersion < 1) throw new Error("invalid remote prompt version");
  if (typeof input.template !== "string" || !input.template || input.template.length > 64 * 1_024) {
    throw new Error("managed prompt template must be a nonempty text prompt");
  }
  assertHash(input.contentHash, "content hash"); assertHash(input.sourceFingerprint, "source fingerprint");
  assertHash(input.targetFingerprint, "target fingerprint");
  const variables = normalizedVariables(input.variables);
  if (input.contentHash !== promptTemplateHash(input.template)
      || !same(variables, promptTemplateVariables(input.template))) {
    throw new Error("managed prompt content hash or variables do not match its template");
  }
  assertPromptVariableAbi(input.promptKey as ManagedPromptKey, input.template, variables);
}

function assertPromptVariableAbi(key: ManagedPromptKey, template: unknown, variables: readonly string[]): void {
  if (typeof template !== "string"
      || !same(normalizedVariables([...variables]), promptTemplateVariables(MANAGED_PROMPT_CATALOG[key].template))) {
    throw new QualityStorageConflictError(`Managed prompt variable ABI does not match catalog: ${key}`);
  }
}

function normalizedVariables(values: string[]): string[] {
  if (values.length > 32 || values.some((value) => !/^[a-z][a-z0-9_]{0,63}$/u.test(value))) {
    throw new Error("invalid managed prompt variables");
  }
  return [...new Set(values)].sort();
}
function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
function mapPrompt(row: PromptRow): QualityPromptVersion {
  return { id: row.id, scope: { tenantId: row.tenant_id, integrationId: row.integration_id },
    promptKey: row.prompt_key, remotePromptName: row.remote_prompt_name,
    remotePromptVersion: row.remote_prompt_version, template: row.template_json, contentHash: row.content_hash,
    variables: row.variables, sourceFingerprint: row.source_fingerprint, targetFingerprint: row.target_fingerprint,
    status: row.status, importedBy: { actorType: row.imported_by_actor_type, actorId: row.imported_by_actor_id },
    approvedBy: row.approved_by_actor_type && row.approved_by_actor_id
      ? { actorType: row.approved_by_actor_type, actorId: row.approved_by_actor_id } : undefined,
    activationCommandKey: row.activation_command_key ?? undefined, approvedAt: optionalIso(row.approved_at),
    retiredAt: optionalIso(row.retired_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    version: safeInteger(row.version, "prompt version") };
}
