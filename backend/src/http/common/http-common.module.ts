import { Module } from "@nestjs/common";

import { RunApiContextService } from "./run-api-context.service.js";

@Module({ providers: [RunApiContextService], exports: [RunApiContextService] })
export class HttpCommonModule {}
