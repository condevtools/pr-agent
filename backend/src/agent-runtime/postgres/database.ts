import type { Pool, PoolClient } from "pg";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RuntimeDatabase {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!UUID_PATTERN.test(tenantId)) {
      throw new Error("tenantId must be a UUID");
    }
    return this.withClient(async (client) => {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      return fn(client);
    });
  }

  /**
   * Trusted control-plane transaction. Never expose this through request input.
   * It exists for the platform integration registry, which is the source of the
   * tenant context used by subsequent tenant-scoped transactions.
   */
  async trustedTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.withClient(fn);
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
