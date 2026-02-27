import { Injectable, Inject, Logger } from "@nestjs/common";
import { DB_TOKEN } from "./db-token.js";

/** Plan-specific limits for subscription enforcement. */
const PLAN_LIMITS = {
  free: { monthlyReviews: 50, maxRepos: 3 },
  pro: { monthlyReviews: 2_000, maxRepos: 50 },
  enterprise: { monthlyReviews: Infinity, maxRepos: Infinity },
} as const;

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(@Inject(DB_TOKEN) private readonly db: unknown) {}

  /**
   * Check whether an organization has exceeded its plan limits.
   * Returns `{ exceeded: false }` when the DB is unavailable (graceful degradation).
   */
  async checkLimits(
    organizationId: string,
    plan: "free" | "pro" | "enterprise",
  ): Promise<{ exceeded: boolean; reason?: string }> {
    if (!this.db) return { exceeded: false };

    const limits = PLAN_LIMITS[plan];

    try {
      const db = this.db as {
        usageRecord: {
          count: (args: Record<string, unknown>) => Promise<number>;
        };
        installation: {
          count: (args: Record<string, unknown>) => Promise<number>;
        };
      };

      const periodStart = new Date();
      periodStart.setDate(1);
      periodStart.setHours(0, 0, 0, 0);

      const [reviewCount, repoCount] = await Promise.all([
        db.usageRecord.count({
          where: {
            organizationId,
            eventType: "review",
            createdAt: { gte: periodStart },
          },
        }),
        db.installation.count({
          where: {
            organizationId,
            status: "active",
          },
        }),
      ]);

      if (reviewCount >= limits.monthlyReviews) {
        return {
          exceeded: true,
          reason: `Monthly review limit reached (${reviewCount}/${limits.monthlyReviews})`,
        };
      }

      if (repoCount > limits.maxRepos) {
        return {
          exceeded: true,
          reason: `Repository limit reached (${repoCount}/${limits.maxRepos})`,
        };
      }

      return { exceeded: false };
    } catch (error) {
      this.logger.warn(
        `Failed to check usage limits for org ${organizationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { exceeded: false };
    }
  }
}
