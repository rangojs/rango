import type { RouteContext } from './types';

/**
 * Create a mock RouteContext for testing
 */
export function createMockContext(
  pathname: string = '/',
  params: Record<string, string> = {},
  searchParams: Record<string, string> = {}
): RouteContext {
  const url = new URL(`http://localhost${pathname}`);
  Object.entries(searchParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return {
    params,
    searchParams: url.searchParams,
    pathname,
    url,
    request: new Request(url.toString()),
    meta: {},
  };
}

/**
 * Create a mock Request object
 */
export function createMockRequest(
  pathname: string,
  options?: {
    method?: string;
    searchParams?: Record<string, string>;
    headers?: Record<string, string>;
  }
): Request {
  const url = new URL(`http://localhost${pathname}`);

  if (options?.searchParams) {
    Object.entries(options.searchParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const headers = new Headers(options?.headers);

  return new Request(url.toString(), {
    method: options?.method || 'GET',
    headers,
  });
}

/**
 * Test component factory
 */
export function createTestComponent(name: string) {
  return function TestComponent(props: any) {
    return <div data-testid={name} {...props}>{name}</div>;
  };
}

/**
 * Async test component factory
 */
export function createAsyncTestComponent(name: string, delay: number = 0) {
  return async function AsyncTestComponent(props: any) {
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return <div data-testid={`async-${name}`} {...props}>{name}</div>;
  };
}

/**
 * Create a test route handler
 */
export function createTestHandler(name: string) {
  return async (ctx: RouteContext) => {
    return <div data-testid={`handler-${name}`}>
      {name}: {ctx.pathname}
    </div>;
  };
}

/**
 * Wait for async operations to complete
 */
export async function waitFor(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Track middleware execution
 */
export class MiddlewareTracker {
  private executionLog: string[] = [];

  createMiddleware(name: string) {
    return async (ctx: RouteContext, next: () => Promise<void>) => {
      this.executionLog.push(`${name}-before`);
      await next();
      this.executionLog.push(`${name}-after`);
    };
  }

  getLog() {
    return this.executionLog;
  }

  clear() {
    this.executionLog = [];
  }
}