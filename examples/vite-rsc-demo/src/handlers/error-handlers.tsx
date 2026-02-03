import type { HandlerContext } from "@rangojs/router";
import { createLoader, notFound } from "@rangojs/router/server";

/**
 * Handler that throws an error
 */
export function ErrorsThrowPage(_ctx: HandlerContext): never {
  throw new Error("Simulated handler error - something went wrong!");
}

/**
 * Handler that throws notFound
 */
export function ErrorsNotFoundPage(_ctx: HandlerContext): never {
  throw notFound("The requested page content was not found");
}

/**
 * Unhandled error - bubbles to root
 */
export function ErrorsUnhandledPage(_ctx: HandlerContext): never {
  throw new Error("This error is NOT caught by any route error boundary - it bubbles to root");
}

/**
 * Loader that deliberately throws an error
 */
export const ErrorPageLoader = createLoader(async () => {
  throw new Error("Simulated loader failure - database connection timeout");
});

/**
 * Loader that throws notFound()
 */
export const NotFoundLoader = createLoader(async () => {
  const resource = null;
  if (!resource) {
    throw notFound("The requested resource was not found in the database");
  }
  return resource;
});
