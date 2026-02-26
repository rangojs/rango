/**
 * Response Error Payload Builder
 *
 * Builds a ResponseError object from a caught error, controlling
 * what information is exposed based on error type and environment.
 */

import { RouterError } from "../errors.js";
import type { ResponseError } from "../urls.js";

/**
 * Build a ResponseError payload from a caught error.
 * RouterError messages are always exposed (developer-crafted).
 * Standard Error messages are hidden in production.
 */
export function createResponseErrorPayload(
  error: unknown,
  isDev: boolean,
): ResponseError {
  if (error instanceof RouterError) {
    return {
      message: error.message,
      code: error.code,
      ...(error.type ? { type: error.type } : {}),
      ...(isDev && error.stack ? { stack: error.stack } : {}),
    };
  }
  if (error instanceof Error) {
    return {
      message: isDev ? error.message : "Internal Server Error",
      ...(isDev && error.stack ? { stack: error.stack } : {}),
    };
  }
  return {
    message: isDev ? String(error) : "Internal Server Error",
  };
}
