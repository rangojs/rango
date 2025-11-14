/**
 * Custom error classes for RSC Router
 *
 * All errors include:
 * - Descriptive names for easy identification
 * - Cause property for structured debugging data
 */

/**
 * Options for error construction
 */
interface ErrorOptions {
  cause?: unknown;
}

/**
 * Thrown when no route matches the requested pathname
 */
export class RouteNotFoundError extends Error {
  name = 'RouteNotFoundError' as const;
  cause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.cause = options?.cause;
  }
}

/**
 * Thrown when middleware execution fails
 */
export class MiddlewareError extends Error {
  name = 'MiddlewareError' as const;
  cause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.cause = options?.cause;
  }
}

/**
 * Thrown when a route handler fails
 */
export class HandlerError extends Error {
  name = 'HandlerError' as const;
  cause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.cause = options?.cause;
  }
}

/**
 * Thrown when segment building fails
 */
export class BuildError extends Error {
  name = 'BuildError' as const;
  cause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.cause = options?.cause;
  }
}

/**
 * Thrown when route handler returns invalid type
 */
export class InvalidHandlerError extends Error {
  name = 'InvalidHandlerError' as const;
  cause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.cause = options?.cause;
  }
}

/**
 * Sanitize errors for production - prevents leaking sensitive information
 *
 * SECURITY CRITICAL:
 * - In production: NEVER send stack traces, file paths, or internal state
 * - In development: Show full error details for debugging
 * - ALWAYS consume error.stack to prevent memory leaks
 *
 * @param error - Error to sanitize
 * @returns Response suitable for sending to client
 */
export function sanitizeError(error: unknown): Response {
  // CRITICAL: Consume stack trace to prevent memory leaks
  if (error && typeof error === 'object' && 'stack' in error) {
    const _ = error.stack; // Force V8 to generate/consume stack trace
  }

  // Response objects are safe to return as-is
  if (error instanceof Response) {
    return error;
  }

  const isDev = (import.meta as any).env?.DEV ?? true; // Default to dev (safer for debugging)

  if (isDev) {
    // Development: Send full error details for debugging
    const errorDetails = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      cause: error && typeof error === 'object' && 'cause' in error ? (error as any).cause : undefined,
    };

    return new Response(JSON.stringify(errorDetails, null, 2), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // Production: Generic error only - NO internal details
  // SECURITY: Never leak stack traces, file paths, or application state
  return new Response('Internal Server Error', {
    status: 500,
    headers: {
      'Content-Type': 'text/plain',
    },
  });
}

