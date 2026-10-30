import { Pool } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

import { PublicationAuthorityStore } from "../authority/publication-authority.js";
import { PublicationBatchCoordinator, PublicationBatchStore } from "../publication/batches.js";
import { RuntimeDatabase } from "../postgres/database.js";
import { PgPublicationStore, PublicationService } from "../publication/publication.js";
import { PgBusinessStateStore } from "../state/business-state.js";
import { agentRuntimePoolConfig } from "./config.js";

export interface AgentRuntimeServices {
  pool: Pool;
  db: RuntimeDatabase;
  operationStore: PgPublicationStore;
  service: PublicationService;
  authority: PublicationAuthorityStore;
  batchStore: PublicationBatchStore;
  batchCoordinator: PublicationBatchCoordinator;
  businessState: PgBusinessStateStore;
  assertRole(): Promise<void>;
  close(): Promise<void>;
}

export function createAgentRuntimeServices(): AgentRuntimeServices {
  const pool = new Pool(agentRuntimePoolConfig());
  pool.on("error", () => process.emitWarning("Harness PostgreSQL idle connection failed"));
  const db = new RuntimeDatabase(pool);
  const operationStore = new PgPublicationStore(db);
  const service = new PublicationService(operationStore);
  const batchStore = new PublicationBatchStore(db);
  let roleCheck: Promise<void> | undefined;
  let closed = false;
  const services: AgentRuntimeServices = {
    pool, db, operationStore, service,
    authority: new PublicationAuthorityStore(db),
    batchStore,
    batchCoordinator: new PublicationBatchCoordinator(batchStore, service),
    businessState: new PgBusinessStateStore(db),
    assertRole: async () => {
      roleCheck ??= pool.query<{ rolsuper: boolean; rolbypassrls: boolean; schema_owner: boolean }>(
        `SELECT r.rolsuper,r.rolbypassrls,
                (n.nspowner=r.oid OR pg_has_role(r.oid,n.nspowner,'MEMBER')) AS schema_owner
         FROM pg_roles r JOIN pg_namespace n ON n.nspname='pr_agent_harness'
         WHERE r.rolname=current_user`,
      ).then((result) => {
        const role = result.rows[0];
        if (!role || role.rolsuper || role.rolbypassrls || role.schema_owner) {
          throw new Error("Harness runtime requires a non-owner NOSUPERUSER NOBYPASSRLS PostgreSQL role");
        }
      }).catch((error: unknown) => { roleCheck = undefined; throw error; });
      await roleCheck;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
  return services;
}

let applicationServices: AgentRuntimeServices | undefined;
const executionServices = new AsyncLocalStorage<AgentRuntimeServices>();

export async function getAgentRuntimeServices(): Promise<AgentRuntimeServices> {
  const scoped = executionServices.getStore();
  if (scoped) return scoped;
  applicationServices ??= createAgentRuntimeServices();
  await applicationServices.assertRole();
  return applicationServices;
}

export function withAgentRuntimeServices<T>(
  services: AgentRuntimeServices,
  callback: () => Promise<T>,
): Promise<T> {
  return executionServices.run(services, callback);
}

export async function closeApplicationRuntimeServices(): Promise<void> {
  const previous = applicationServices;
  applicationServices = undefined;
  await previous?.close();
}
