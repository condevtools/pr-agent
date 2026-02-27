import { createParamDecorator, ExecutionContext } from "@nestjs/common";

/**
 * Parameter decorator that extracts the resolved TenantConfig
 * from the request object (set by SubscriptionGuard).
 *
 * Usage:
 *   @Post('trigger')
 *   @UseGuards(SubscriptionGuard)
 *   async trigger(@CurrentTenant() tenant?: TenantConfig) { ... }
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{
      tenantConfig?: unknown;
    }>();
    return request.tenantConfig ?? null;
  },
);
