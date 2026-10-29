import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";

import { FixStoreError } from "../../../fix/errors.js";
import { RunControlError } from "../../../agent-runtime/runs/control-contracts.js";
import { RunCursorExpiredError } from "../../../agent-runtime/runs/query-store.js";
import { ModelBudgetExceededError } from "../../../agent-runtime/budget/model-budget-store.js";
import { RunCreateConflictError } from "../../../agent-runtime/postgres/run-store.js";

@Catch()
export class RunApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) { response.end(); return; }
    if (error instanceof RunControlError) {
      if (error.status === 401) response.setHeader("WWW-Authenticate", "Bearer");
      response.status(error.status).json({ error: { code: error.code, message: error.message },
        ...(error instanceof RunCursorExpiredError ? { snapshot: error.snapshot, resumeCursor: error.resumeCursor } : {}) });
    } else if (error instanceof FixStoreError) {
      const status = error.code.endsWith("_not_found") ? 404 : error.code === "maker_checker_violation" ? 403 : 409;
      response.status(status).json({ error: { code: error.code, message: "Fix request conflicts with its verified state" } });
    } else if (error instanceof ZodError) {
      response.status(422).json({ error: { code: "INVALID_REQUEST", message: "Request does not match the Run API schema" } });
    } else if (error instanceof RunCreateConflictError) {
      response.status(409).json({ error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key was used for a different request" } });
    } else if (error instanceof ModelBudgetExceededError) {
      response.status(429).json({ error: { code: "BUDGET_EXCEEDED", message: "Run budget admission was refused" } });
    } else {
      process.emitWarning(JSON.stringify({ component: "run-api", errorType: error instanceof Error ? error.name : "unknown" }));
      response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Run request could not be completed" } });
    }
  }
}
