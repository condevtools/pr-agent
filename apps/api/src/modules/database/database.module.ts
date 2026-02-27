import { Global, Module, OnModuleDestroy } from "@nestjs/common";
import { DB_TOKEN } from "./db-token.js";
import { TenantService } from "./tenant.service.js";
import { UsageService } from "./usage.service.js";

/**
 * Lazily provides the PrismaClient from `@mr-agent/db`.
 *
 * When `DATABASE_URL` is not configured, the provider resolves to `null`
 * so that every consumer can gracefully degrade without a hard dependency
 * on a running PostgreSQL instance.
 */
async function createPrismaClient() {
  if (!process.env["DATABASE_URL"]) {
    return null;
  }
  try {
    const { getDefaultDb } = await import("@mr-agent/db");
    return getDefaultDb();
  } catch {
    return null;
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      useFactory: createPrismaClient,
    },
    TenantService,
    UsageService,
  ],
  exports: [DB_TOKEN, TenantService, UsageService],
})
export class DatabaseModule implements OnModuleDestroy {
  async onModuleDestroy() {
    if (!process.env["DATABASE_URL"]) return;
    try {
      const { closeDefaultDb } = await import("@mr-agent/db");
      await closeDefaultDb();
    } catch {
      // DB module may not be available
    }
  }
}
