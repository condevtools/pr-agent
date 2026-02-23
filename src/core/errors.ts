export class WebhookAuthError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 401) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "WebhookAuthError";
    this.statusCode = statusCode;
  }
}

export class BadWebhookRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "BadWebhookRequestError";
    this.statusCode = statusCode;
  }
}

export function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error), { cause: error });
}
