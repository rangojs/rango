/**
 * Router Middleware Execution
 *
 * Middleware chain execution for RSC Router.
 */

import { track } from "../server/context";
import type { HandlerContext } from "../types";

/**
 * Execute middleware chain with recursive chaining
 * Returns Response if middleware short-circuits, null otherwise
 */
export async function executeMiddleware<TEnv>(
  middleware: any[],
  ctx: HandlerContext<any, TEnv>,
  entryId?: string
): Promise<Response | null> {
  if (middleware.length === 0) {
    return null;
  }

  let index = 0;
  let earlyResponse: Response | null = null;

  const next = async (): Promise<void> => {
    if (index >= middleware.length || earlyResponse) {
      return; // Stop if reached end or middleware returned Response
    }

    const currentIndex = index++;
    const currentMiddleware = middleware[currentIndex];

    // Track each middleware execution
    const mwName = currentMiddleware.name || `mw${currentIndex}`;
    const label = entryId
      ? `middleware:${entryId}.${mwName}`
      : `middleware:${mwName}`;
    const done = track(label);

    try {
      const result = await currentMiddleware(ctx, next);
      done();

      // Check if middleware short-circuited with Response
      if (result instanceof Response) {
        earlyResponse = result;
        console.log(
          `[Router.executeMiddleware] Middleware returned Response - short-circuit`
        );
      }
    } catch (error) {
      done();
      // Middleware threw error - propagate it
      console.error(
        `[Router.executeMiddleware] Middleware threw error:`,
        error
      );
      throw error;
    }
  };

  await next();
  return earlyResponse; // null if all middleware called next()
}
