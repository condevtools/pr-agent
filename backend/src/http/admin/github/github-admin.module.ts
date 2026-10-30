import { Module } from "@nestjs/common";
import { HttpCommonModule } from "../../common/http-common.module.js";
import { GitHubAdminController } from "./github-admin.controller.js";
import { GitHubAdminService } from "./github-admin.service.js";

@Module({ imports: [HttpCommonModule], controllers: [GitHubAdminController], providers: [GitHubAdminService] })
export class GitHubAdminModule {}
