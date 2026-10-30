import { Module } from "@nestjs/common";

import { GithubWebhookController } from "./github-webhook.controller.js";
import { GithubWebhookService } from "./github-webhook.service.js";
import { HttpCommonModule } from "../../common/http-common.module.js";

@Module({
  imports: [HttpCommonModule],
  controllers: [GithubWebhookController],
  providers: [GithubWebhookService],
})
export class GithubModule {}
