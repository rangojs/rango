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
  name = "RouteNotFoundError" as const;
  cause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.cause = options?.cause;
  }
}

/**
 * Thrown when data is not found (e.g., product with ID doesn't exist)
 * Use this in handlers/loaders to trigger the nearest notFoundBoundary
 *
 * @example
 * ```typescript
 * route("products.detail", async (ctx) => {
 *   const product = await db.products.get(ctx.params.slug);
 *   if (!product) throw new DataNotFoundError("Product not found");
 *   return <ProductDetail product={product} />;
 * });
 * ```
 */
export class DataNotFoundError extends Error {
  name = "DataNotFoundError" as const;
  cause?: unknown;

  constructor(message: string = "Not found", options?: ErrorOptions) {
    super(message);
    this.cause = options?.cause;
  }
}

/**
 * Convenience function to throw a DataNotFoundError
 * Shorter syntax for common not-found scenarios
 *
 * @example
 * ```typescript
 * const product = await db.products.get(slug);
 * if (!product) throw notFound("Product not found");
 * // or simply:
 * if (!product) throw notFound();
 * ```
 */
export function notFound(message?: string): never {
  throw new DataNotFoundError(message);
}

/**
 * Thrown when middleware execution fails
 */
export class MiddlewareError extends Error {
  name = "MiddlewareError" as const;
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
  name = "HandlerError" as const;
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
  name = "BuildError" as const;
  cause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.cause = options?.cause;
  }
}

/**
 * Thrown when a network request fails (server unreachable, no internet, etc.)
 * This error triggers the root error boundary with retry capability.
 *
 * @example
 * ```typescript
 * try {
 *   await fetch(url);
 * } catch (error) {
 *   if (error instanceof TypeError) {
 *     throw new NetworkError("Unable to connect to server", { cause: error });
 *   }
 *   throw error;
 * }
 * ```
 */
export class NetworkError extends Error {
  name = "NetworkError" as const;
  cause?: unknown;
  /** The URL that failed to fetch */
  url?: string;
  /** Whether this was during an action, navigation, or revalidation */
  operation?: "action" | "navigation" | "revalidation";

  constructor(
    message: string = "Network request failed",
    options?: ErrorOptions & {
      url?: string;
      operation?: "action" | "navigation" | "revalidation";
    }
  ) {
    super(message);
    this.cause = options?.cause;
    this.url = options?.url;
    this.operation = options?.operation;
  }
}

/**
 * Check if an error is a network-level failure (server unreachable, no internet)
 * These are typically TypeError from fetch when the network request itself fails.
 */
export function isNetworkError(error: unknown): boolean {
  // NetworkError we throw ourselves
  if (error instanceof NetworkError) {
    return true;
  }

  // TypeError from fetch() when network fails (e.g., "Failed to fetch")
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    return (
      message.includes("failed to fetch") ||
      message.includes("network request failed") ||
      message.includes("networkerror") ||
      message.includes("load failed")
    );
  }

  // DOMException with network-related names
  if (error instanceof DOMException) {
    return error.name === "NetworkError";
  }

  return false;
}

/**
 * Structured error for JSON response routes.
 * Thrown by handlers to return a typed error envelope with a specific HTTP status.
 *
 * Unlike standard Error, RouterError messages are always exposed to the client
 * (the developer intentionally crafted them for consumers).
 *
 * @example
 * ```typescript
 * path("/products/:id", (ctx) => {
 *   const product = products.find(p => p.id === ctx.params.id);
 *   if (!product) throw new RouterError("NOT_FOUND", "Product not found", { status: 404 });
 *   return product;
 * }, { name: "productDetail" })
 * ```
 */
export class RouterError extends Error {
  name = "RouterError" as const;
  code: string;
  type?: string;
  status: number;
  cause?: unknown;

  constructor(code: string, message: string, options?: {
    status?: number;
    type?: string;
    cause?: unknown;
  }) {
    super(message);
    this.code = code;
    this.status = options?.status ?? 500;
    this.type = options?.type;
    this.cause = options?.cause;
  }
}

/**
 * Thrown by the partial updater when the server responds with a redirect payload
 * that carries location state. Caught by navigate() to re-navigate to the
 * redirect target with the server-set state merged into history.pushState.
 *
 * Not an Error subclass -- this is a control flow signal, not a failure.
 */
export class ServerRedirect {
  readonly name = "ServerRedirect";
  constructor(
    public readonly url: string,
    public readonly state: Record<string, unknown> | undefined,
  ) {}
}

/**
 * Thrown when route handler returns invalid type
 */
export class InvalidHandlerError extends Error {
  name = "InvalidHandlerError" as const;
  cause?: unknown;

  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.cause = options?.cause;
  }
}

/**
 * Internal invariant assertion for development-time checks
 *
 * @internal
 * @param condition - Condition that must be true
 * @param message - Error message to throw if condition is false
 * @throws {Error} If condition is false
 *
 * @example
 * ```typescript
 * invariant(user !== null, 'User must be defined');
 * invariant(node.type === 'layout', `Expected layout, got ${node.type}`);
 * ```
 */
export function invariant(condition: any, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invariant: ${message}`);
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
  if (error && typeof error === "object" && "stack" in error) {
    const _ = error.stack; // Force V8 to generate/consume stack trace
  }

  // Response objects are safe to return as-is
  if (error instanceof Response) {
    return error;
  }

  const isDev = (import.meta as any).env?.DEV ?? true;

  if (isDev) {
    // Development: Send full error details for debugging
    const errorDetails = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      cause:
        error && typeof error === "object" && "cause" in error
          ? (error as any).cause
          : undefined,
    };

    return new Response(JSON.stringify(errorDetails, null, 2), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  // Production: Generic error only - NO internal details
  // SECURITY: Never leak stack traces, file paths, or application state
  return new Response("Internal Server Error", {
    status: 500,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}
