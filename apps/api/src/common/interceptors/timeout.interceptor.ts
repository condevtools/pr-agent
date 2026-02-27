import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  RequestTimeoutException,
} from "@nestjs/common";
import { Observable, throwError, TimeoutError } from "rxjs";
import { catchError, timeout } from "rxjs/operators";
import { readNumberEnv } from "@mr-agent/core";

const DEFAULT_WEBHOOK_TIMEOUT_MS = 30_000;

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const timeoutMs = readNumberEnv(
      "WEBHOOK_TIMEOUT_MS",
      DEFAULT_WEBHOOK_TIMEOUT_MS,
    );

    return next.handle().pipe(
      timeout(timeoutMs),
      catchError((err: unknown) => {
        if (err instanceof TimeoutError) {
          return throwError(() => new RequestTimeoutException("Request timeout"));
        }
        return throwError(() => err);
      }),
    );
  }
}
