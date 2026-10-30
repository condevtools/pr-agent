import { Module } from "@nestjs/common";

import { GitlabWebhookController } from "./gitlab-webhook.controller.js";
import { GitlabWebhookService } from "./gitlab-webhook.service.js";
import { HttpCommonModule } from "../../common/http-common.module.js";

@Module({
  imports: [HttpCommonModule],
  controllers: [GitlabWebhookController],
  providers: [GitlabWebhookService],
})
export class GitlabModule {}
