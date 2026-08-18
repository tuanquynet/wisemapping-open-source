/**
 * Application error hierarchy.
 *
 * Replaces the Java `ClientException`/`WiseMappingException` tree and the 26
 * `@ExceptionHandler` methods of `GlobalExceptionHandler`. Each error carries
 * its own HTTP status and severity, so the handler is a single function rather
 * than a dispatch table.
 *
 * Messages are English literals. The Java app resolves them through
 * `messages_*.properties` for 13 locales; i18n is out of scope here.
 */

/** Matches `com.wisemapping.exceptions.Severity`. */
export type Severity = "INFO" | "WARNING" | "SEVERE" | "FATAL";

export abstract class AppError extends Error {
  abstract readonly status: number;
  readonly severity: Severity = "WARNING";
  /** Per-field messages, as in the `fieldErrors` map of `RestErrors`. */
  readonly fieldErrors: Readonly<Record<string, string>> = {};

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  readonly status = 400;
}

export class ValidationError extends AppError {
  readonly status = 400;
  override readonly fieldErrors: Readonly<Record<string, string>>;

  constructor(
    fieldErrors: Record<string, string>,
    message = "Validation failed",
  ) {
    super(message);
    this.fieldErrors = Object.freeze({ ...fieldErrors });
  }
}

export class UnauthorizedError extends AppError {
  readonly status = 401;
}

/** Wrong email/password, or an account that cannot authenticate. */
export class InvalidCredentialsError extends UnauthorizedError {
  constructor(
    message = "The email address or password you entered is incorrect.",
  ) {
    super(message);
  }
}

export class AccountNotActivatedError extends UnauthorizedError {
  constructor(
    message = "The account has not been activated yet. Check your email.",
  ) {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  readonly status = 403;
}

export class AccessDeniedError extends ForbiddenError {
  constructor(message = "You do not have permission to perform this action.") {
    super(message);
  }
}

export class NotFoundError extends AppError {
  readonly status = 404;
}

export class MapNotFoundError extends NotFoundError {
  constructor(id: number) {
    super(`Map with id ${id} could not be found.`);
  }
}

export class ConflictError extends AppError {
  readonly status = 409;
}

/** The map is being edited by someone else. Mirrors Java's `LockException`. */
export class LockError extends AppError {
  readonly status = 409;

  static lockLost(): LockError {
    return new LockError("The map is currently being edited by another user.");
  }
}

export class TooManyLocksError extends AppError {
  readonly status = 503;
  override readonly severity: Severity = "SEVERE";
}

/**
 * Registration failure. 400 rather than the Java app's 500 for
 * `UserRegistrationException` -- a rejected registration is a client error, and
 * a 500 tells the frontend to show "something went wrong" instead of the reason.
 */
export class RegistrationError extends AppError {
  readonly status = 400;
}
