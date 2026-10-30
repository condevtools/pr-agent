import { Module } from "@nestjs/common";
import { APP_GUARD, DiscoveryModule } from "@nestjs/core";
import { RouteAccessGuard } from "./route-access.js";

import { RunApiContextService } from "./run-api-context.service.js";

@Module({ imports: [DiscoveryModule], providers: [RunApiContextService, { provide: APP_GUARD, useClass: RouteAccessGuard }], exports: [RunApiContextService] })
export class HttpCommonModule {}
