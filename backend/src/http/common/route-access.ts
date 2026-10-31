import { HttpException, Inject, Injectable, SetMetadata,
  type CanActivate, type ExecutionContext, type OnModuleInit } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants.js";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import type { Request } from "express";
import { RUN_PERMISSIONS, RunControlError, requireRunPermission, type RunPermission } from "../../agent-runtime/runs/control-contracts.js";
import { incrementMetricCounter } from "../system/metrics-runtime.js";
import { RunApiContextService } from "./run-api-context.service.js";
import { logCore } from "#core";

const ROUTE_ACCESS = Symbol("route-access");
type AccessPolicy = RunPermission | "public" | "signed-webhook" | "runs:command";
/** Every HTTP method declares its boundary; there is deliberately no class-wide public default. */
export const RouteAccess = (policy: AccessPolicy): MethodDecorator => SetMetadata(ROUTE_ACCESS, policy);

@Injectable()
export class RouteAccessGuard implements CanActivate, OnModuleInit {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(RunApiContextService) private readonly context: RunApiContextService,
  ) {}

  onModuleInit(): void {
    const scanner = new MetadataScanner();
    for (const { instance, metatype } of this.discovery.getControllers()) {
      if (!instance) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, Function>;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name]!;
        if (Reflect.getMetadata(METHOD_METADATA, handler) !== undefined
            && !validPolicy(this.reflector.get<AccessPolicy>(ROUTE_ACCESS, handler))) {
          throw new Error(`Missing route access policy: ${metatype?.name ?? "Controller"}.${name}`);
        }
      }
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const policy = this.reflector.get<AccessPolicy>(ROUTE_ACCESS, context.getHandler());
    if (!validPolicy(policy)) throw new HttpException("Route access policy is missing", 503);
    // Signed transport controllers authenticate before parsing/dispatch; they are
    // explicitly distinguished from public liveness endpoints.
    if (policy === "public" || policy === "signed-webhook") return true;
    const request = context.switchToHttp().getRequest<Request>();
    try {
      const principal = this.context.authenticate(request);
      if (policy === "runs:command") {
        const kind = request.params.kind;
        if (typeof kind !== "string" || !["cancel", "resume", "retry", "recover", "rerun"].includes(kind)) {
          throw new RunControlError("INVALID_COMMAND", 400, "Unknown Run command");
        }
        requireRunPermission(principal, `runs:${kind}` as RunPermission);
      } else {
        requireRunPermission(principal, policy);
      }
      return true;
    } catch (error) {
      if (error instanceof RunControlError) {
        this.recordDenial(context, policy, error);
        throw new HttpException({ error: { code: error.code, message: error.message } }, error.status);
      }
      throw error;
    }
  }

  private recordDenial(
    context: ExecutionContext,
    policy: Exclude<AccessPolicy, "public" | "signed-webhook">,
    error: RunControlError,
  ): void {
    const controllerMethod = `${context.getClass().name || "UnknownController"}.${
      context.getHandler().name || "unknown"}`;
    const fields = {
      code: error.code,
      policy,
      controllerMethod,
      status: error.status,
    };
    incrementMetricCounter("pr_agent_route_access_denials_total", {
      code: fields.code,
      policy: fields.policy,
      controller_method: fields.controllerMethod,
      status: String(fields.status),
    });
    logCore("warn", "route_access.denied", { domainCode: fields.code, ...fields });
  }
}

function validPolicy(policy: unknown): policy is AccessPolicy {
  return typeof policy === "string"
    && (["public", "signed-webhook", "runs:command", ...RUN_PERMISSIONS] as string[]).includes(policy);
}
