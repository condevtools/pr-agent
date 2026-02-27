import { PrismaClient } from "@prisma/client";

export type { PrismaClient };

let defaultClient: PrismaClient | null = null;

export function createDbClient(databaseUrl?: string): PrismaClient {
  return new PrismaClient({
    datasourceUrl: databaseUrl,
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

export function getDefaultDb(): PrismaClient | null {
  if (!process.env.DATABASE_URL) return null;
  if (!defaultClient) {
    defaultClient = createDbClient();
  }
  return defaultClient;
}

export async function closeDefaultDb(): Promise<void> {
  if (defaultClient) {
    await defaultClient.$disconnect();
    defaultClient = null;
  }
}
