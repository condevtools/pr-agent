import { Injectable, Inject, Logger } from "@nestjs/common";
import { DB_TOKEN } from "./db-token.js";

@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(@Inject(DB_TOKEN) private readonly db: unknown) {}

  /**
   * Resolve a tenant configuration from a GitHub installation ID.
   * Returns `null` when the DB is unavailable or the installation is not found,
   * allowing callers to fall back to env-var-based configuration.
   */
  async resolveTenant(installationId: number) {
    if (!this.db) return null;

    try {
      const { resolveTenantFromInstallation } = await import("@mr-agent/db");
      return await resolveTenantFromInstallation(
        this.db as Parameters<typeof resolveTenantFromInstallation>[0],
        installationId,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to resolve tenant for installation ${installationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** Returns true when a DB connection is available. */
  isAvailable(): boolean {
    return this.db != null;
  }
}
