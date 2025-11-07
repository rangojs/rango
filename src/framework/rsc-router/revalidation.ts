import type {
  RevalidationContext,
  RevalidationHandler,
  RouteContext,
} from "./types";

/**
 * Revalidation manager for fine-grained control over route revalidation
 */
export class RevalidationManager {
  private revalidationHandlers: Map<string, RevalidationHandler> = new Map();
  private defaultRevalidation: RevalidationHandler | null = null;

  /**
   * Register a revalidation handler for a specific route
   */
  register(routeName: string, handler: RevalidationHandler) {
    this.revalidationHandlers.set(routeName, handler);
  }

  /**
   * Set default revalidation handler for all routes
   */
  setDefault(handler: RevalidationHandler) {
    this.defaultRevalidation = handler;
  }

  /**
   * Check if a route should revalidate based on navigation context
   */
  async shouldRevalidate(
    currentPath: string,
    nextPath: string,
    currentRouteName?: string,
    nextRouteName?: string,
    request?: Request,
    params?: Record<string, string>,
    actionData?: any
  ): Promise<boolean> {
    // Build revalidation context
    const context: RevalidationContext = {
      currentPath,
      nextPath,
      currentRouteName,
      nextRouteName,
      params: params || {},
      request: request || new Request(nextPath),
      actionData,
      actionParams: {},
    };

    // Check if there's a specific handler for the next route
    if (nextRouteName) {
      const handler = this.revalidationHandlers.get(nextRouteName);
      if (handler) {
        return await handler(context);
      }
    }

    // Fall back to default handler
    if (this.defaultRevalidation) {
      return await this.defaultRevalidation(context);
    }

    // Default behavior: always revalidate when path changes
    return currentPath !== nextPath;
  }

  /**
   * Merge revalidation handlers from route metadata
   */
  mergeFromMetadata(metadata: any) {
    if (typeof metadata === "function") {
      // Single revalidation function for all routes
      this.setDefault(metadata);
    } else if (typeof metadata === "object") {
      // Per-route revalidation functions
      for (const [routeName, handler] of Object.entries(metadata)) {
        if (typeof handler === "function") {
          this.register(routeName, handler as RevalidationHandler);
        }
      }
    }
  }
}

/**
 * Enhanced route context with revalidation support
 */
export interface EnhancedRouteContext extends RouteContext {
  shouldRevalidate?: (next: RouteContext) => boolean | Promise<boolean>;
}

/**
 * Wrap a route handler with revalidation logic
 */
export function withRevalidation<T extends RouteContext>(
  handler: (ctx: T) => any,
  revalidationHandler?: RevalidationHandler
): (ctx: T) => any {
  return async (ctx: T) => {
    // Store revalidation handler in context meta
    if (revalidationHandler) {
      ctx.meta.revalidate = revalidationHandler;
    }

    // Execute original handler
    return await handler(ctx);
  };
}

/**
 * Common revalidation strategies
 */
export const RevalidationStrategies = {
  /**
   * Always revalidate when navigating
   */
  always: (): RevalidationHandler => {
    return () => true;
  },

  /**
   * Never revalidate (static content)
   */
  never: (): RevalidationHandler => {
    return () => false;
  },

  /**
   * Revalidate when specific params change
   */
  whenParamsChange: (paramNames: string[]): RevalidationHandler => {
    return (ctx) => {
      for (const param of paramNames) {
        const currentValue = ctx.params[param];
        const nextValue = ctx.actionParams?.[param];
        if (currentValue !== nextValue) {
          return true;
        }
      }
      return false;
    };
  },

  /**
   * Revalidate when path changes
   */
  whenPathChanges: (): RevalidationHandler => {
    return (ctx) => ctx.currentPath !== ctx.nextPath;
  },

  /**
   * Revalidate when route name changes
   */
  whenRouteChanges: (): RevalidationHandler => {
    return (ctx) => ctx.currentRouteName !== ctx.nextRouteName;
  },

  /**
   * Revalidate after a specific time interval
   */
  afterInterval: (milliseconds: number): RevalidationHandler => {
    const lastRevalidation = new Map<string, number>();

    return (ctx) => {
      const now = Date.now();
      const key = ctx.nextPath;
      const last = lastRevalidation.get(key) || 0;

      if (now - last > milliseconds) {
        lastRevalidation.set(key, now);
        return true;
      }

      return false;
    };
  },

  /**
   * Combine multiple strategies with OR logic
   */
  any: (...strategies: RevalidationHandler[]): RevalidationHandler => {
    return async (ctx) => {
      for (const strategy of strategies) {
        if (await strategy(ctx)) {
          return true;
        }
      }
      return false;
    };
  },

  /**
   * Combine multiple strategies with AND logic
   */
  all: (...strategies: RevalidationHandler[]): RevalidationHandler => {
    return async (ctx) => {
      for (const strategy of strategies) {
        if (!(await strategy(ctx))) {
          return false;
        }
      }
      return true;
    };
  },
};