import { Module } from "@nestjs/common";

import { WebhookEventsController } from "./events.controller.js";

@Module({ controllers: [WebhookEventsController] })
export class WebhookEventsModule {}
