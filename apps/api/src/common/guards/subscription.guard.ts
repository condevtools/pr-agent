import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  Logger,
} from "@nestjs/common";
import { TenantService } from "../../modules/database/tenant.service.js";
import { UsageService } from "../../modules/database/usage.service.js";

/**
 * NestJS guard that enforces subscription limits on webhook endpoints.
 *
 * Flow:
 *   1. Extract `installation.id` from the webhook payload.
 *   2. Resolve the tenant via TenantService.
 *   3. Check usage limits via UsageService.
 *   4. Attach resolved TenantConfig to the request for downstream use.
 *   5. Return 429 if limits are exceeded.
 *
 * When the database is unavailable (no DATABASE_URL, connection failure),
 * the guard allows the request through — zero breaking change for
 * env-var-only deployments.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  private readonly logger = new Logger(SubscriptionGuard.name);

  constructor(
    private readonly tenantService: TenantService,
    private readonly usageService: UsageService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.tenantService.isAvailable()) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      body?: { installation?: { id?: number } };
      tenantConfig?: unknown;
    }>();

    const installationId = request?.body?.installation?.id;
    if (!installationId || typeof installationId !== "number") {
      // No installation context (e.g., GitLab webhook) — allow through
      return true;
    }

    const tenant = await this.tenantService.resolveTenant(installationId);
    if (!tenant) {
      // Not a known multi-tenant installation — allow (env-var mode)
      return true;
    }

    // Attach tenant config for downstream use
    request.tenantConfig = tenant;

    const { exceeded, reason } = await this.usageService.checkLimits(
      tenant.tenantId,
      tenant.plan,
    );

    if (exceeded) {
      this.logger.warn(
        `Subscription limit exceeded for tenant ${tenant.tenantId}: ${reason}`,
      );
      throw new HttpException(
        {
          statusCode: 429,
          message: reason ?? "Subscription limit exceeded",
          error: "Too Many Requests",
        },
        429,
      );
    }

    return true;
  }
}
