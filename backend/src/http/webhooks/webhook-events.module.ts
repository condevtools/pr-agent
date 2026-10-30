import { Module } from "@nestjs/common";

import { WebhookEventsController } from "./events.controller.js";
import { HttpCommonModule } from "../common/http-common.module.js";

@Module({ imports: [HttpCommonModule], controllers: [WebhookEventsController] })
export class WebhookEventsModule {}
