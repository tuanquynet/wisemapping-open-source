import type { Context } from "hono";

import { AppError, type Severity } from "../../domain/errors.ts";
import { logger } from "../../util/logger.ts";

/**
 * The error body the frontend parses, mirroring `rest/model/RestErrors.java`.
 *
 * Only three keys survive Jackson there: `fieldErrors`, `globalSeverity` and
 * `globalErrors`. `debugInfo` is populated internally but `@JsonIgnore`d, so it
 * is deliberately absent here too -- adding it would leak internals to a
 * client that has never seen the key.
 */
export interface RestErrors {
  fieldErrors: Record<string, string>;
  globalSeverity: Severity;
  globalErrors: string[];
}

function body(
  message: string,
  severity: Severity,
  fieldErrors: Record<string, string>,
): RestErrors {
  return { fieldErrors, globalSeverity: severity, globalErrors: [message] };
}

/**
 * Terminal error handler, registered via `app.onError`.
 *
 * Note this is NOT the shape of the 401 an unauthenticated request receives --
 * see `unauthorizedBody` below. The Java app has the same split: its
 * authentication entry point writes `{"msg":"Unauthorized"}` directly and never
 * reaches `GlobalExceptionHandler`. Reproduced because the frontend keys off it.
 */
export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    // Expected, client-caused: log at debug so real faults stay visible.
    logger.debug(
      `${c.req.method} ${c.req.path} -> ${err.status} ${err.name}: ${err.message}`,
    );
    return c.json(
      body(err.message, err.severity, { ...err.fieldErrors }),
      err.status as 400,
    );
  }

  logger.error(`Unhandled error on ${c.req.method} ${c.req.path}`, err);
  return c.json(body("An unexpected error occurred.", "FATAL", {}), 500);
}

/**
 * The 401 body produced when authentication is missing or invalid.
 *
 * Shape comes from `config/AppConfig.java` (the API chain's
 * `authenticationEntryPoint`), which is a different shape from `RestErrors`.
 */
export function unauthorizedBody(): { msg: string } {
  return { msg: "Unauthorized" };
}
