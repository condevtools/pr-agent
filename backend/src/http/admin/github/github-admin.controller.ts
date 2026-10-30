import { BadRequestException, Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import type { Request, Response } from "express";

import { RouteAccess } from "../../common/route-access.js";
import { RunApiContextService } from "../../common/run-api-context.service.js";
import { GitHubAdminService } from "./github-admin.service.js";
import { enrollGitHubRepositorySchema, revalidateGitHubRepositorySchema } from "./input.js";

const ASSETS = {
  "app.js": { contentType: "text/javascript; charset=utf-8", url: new URL("./assets/app.js", import.meta.url) },
  "app.css": { contentType: "text/css; charset=utf-8", url: new URL("./assets/app.css", import.meta.url) },
} as const;

@Controller("api/admin/github")
export class GitHubAdminController {
  constructor(
    @Inject(GitHubAdminService) private readonly service: GitHubAdminService,
    @Inject(RunApiContextService) private readonly context: RunApiContextService,
  ) {}

  @Get()
  @RouteAccess("public")
  async page(@Res() response: Response): Promise<void> {
    this.service.assertEnabled();
    secureHeaders(response, "text/html; charset=utf-8");
    response.send(await readFile(new URL("./assets/index.html", import.meta.url), "utf8"));
  }

  @Get("assets/:filename")
  @RouteAccess("public")
  async asset(@Param("filename") filename: string, @Res() response: Response): Promise<void> {
    this.service.assertEnabled();
    secureHeaders(response, "text/plain; charset=utf-8");
    const asset = Object.hasOwn(ASSETS, filename) ? ASSETS[filename as keyof typeof ASSETS] : undefined;
    if (!asset) { response.status(404).send("not found"); return; }
    secureHeaders(response, asset.contentType);
    response.send(await readFile(asset.url));
  }

  @Get("repositories")
  @RouteAccess("repositories:manage")
  async repositories(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    secureHeaders(response, "application/json; charset=utf-8");
    return this.service.repositories(this.context.authenticateRepositoryAdmin(request));
  }

  @Post("repositories")
  @RouteAccess("repositories:manage")
  async enroll(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    secureHeaders(response, "application/json; charset=utf-8");
    return this.service.enroll(this.context.authenticateRepositoryAdmin(request),
      parseInput(enrollGitHubRepositorySchema, request.body));
  }

  @Post("repositories/revalidate")
  @RouteAccess("repositories:manage")
  async revalidate(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    secureHeaders(response, "application/json; charset=utf-8");
    return this.service.revalidate(this.context.authenticateRepositoryAdmin(request),
      parseInput(revalidateGitHubRepositorySchema, request.body));
  }
}

function parseInput<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException("Invalid repository onboarding request");
  return parsed.data;
}

function secureHeaders(response: Response, contentType: string): void {
  response.set({
    "Cache-Control": "no-store", "Content-Type": contentType,
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
  });
}
