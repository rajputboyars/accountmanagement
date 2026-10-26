/**
 * Typed business errors. Messages are written for shop staff and never contain secrets.
 * Route handlers and server actions map `status`/`code` to responses.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION", 422, message, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Please sign in to continue.") {
    super("UNAUTHENTICATED", 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have access to this.") {
    super("FORBIDDEN", 403, message);
  }
}

/** Also used for records that belong to another shop, so their existence is never revealed. */
export class NotFoundError extends AppError {
  constructor(message = "Not found.") {
    super("NOT_FOUND", 404, message);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, 409, message, details);
  }
}

export class RateLimitedError extends AppError {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super("RATE_LIMITED", 429, message, { retryAfterSeconds });
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string) {
    super("CONFIGURATION", 500, message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
