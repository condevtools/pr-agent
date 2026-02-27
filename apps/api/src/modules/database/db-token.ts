/**
 * NestJS injection token for the PrismaClient instance.
 * Extracted into its own file to avoid circular imports between
 * the module definition and service files.
 */
export const DB_TOKEN = "PRISMA_CLIENT";
