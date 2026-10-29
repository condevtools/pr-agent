import { Injectable } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";

import { FeedbackStore } from "../../evolution/feedback-store.js";
import { RunApiAuthenticator } from "../../http/common/run-auth.js";
import { requireRunPermission, RunControlError, type RunPrincipal } from "../../agent-runtime/runs/control-contracts.js";
import { getAgentRuntimeServices } from "../../agent-runtime/runtime.js";

@Injectable()
export class EvolutionFeedbackService {
  private readonly authenticator = new RunApiAuthenticator();

  authenticate(request: Request): RunPrincipal {
    const headers = request.rawHeaders.filter((_value, index) => index % 2 === 0);
    if (headers.filter((name) => name.toLowerCase() === "authorization").length !== 1) {
      throw new RunControlError("UNAUTHORIZED", 401, "Exactly one bearer credential is required");
    }
    return this.authenticator.authenticate(request.headers.authorization);
  }

  async feedback(principal: RunPrincipal, runId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "feedback:create");
    return (await this.store()).recordObservation(principal, validRunId(runId), commandKey(key), body);
  }

  async annotate(principal: RunPrincipal, runId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "annotations:create");
    return (await this.store()).createAnnotation(principal, validRunId(runId), commandKey(key), body);
  }

  async arbitrate(principal: RunPrincipal, runId: string, key: unknown, body: unknown) {
    requireRunPermission(principal, "annotations:arbitrate");
    return (await this.store()).arbitrate(principal, validRunId(runId), commandKey(key), body);
  }

  private async store(): Promise<FeedbackStore> { return new FeedbackStore((await getAgentRuntimeServices()).db); }
}

function validRunId(value: string): string { return z.string().uuid().parse(value); }
function commandKey(value: unknown): string { return z.string().min(1).max(200).parse(value); }
