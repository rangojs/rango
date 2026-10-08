import { vi } from "vitest";
import {
  findNearestErrorBoundary,
  findNearestNotFoundBoundary,
} from "../error-handling.js";

export function createContext(pathname = "/test") {
  const request = new Request(`https://example.com${pathname}`);
  return {
    params: {},
    request,
    searchParams: new URLSearchParams(),
    pathname,
    url: new URL(request.url),
    env: {},
    var: {},
    get: () => undefined,
    set: () => {},
    use: vi.fn(),
  } as any;
}

interface DepsOptions {
  /** Constant boundaries; omit `real` to use them. */
  error?: unknown;
  notFound?: unknown;
  notFoundComponent?: unknown;
  /** Resolve boundaries through the real finders (entry.parent chain). */
  real?: boolean;
}

/**
 * Deps mirroring router.ts trackHandler: a side-effect onError report, the
 * rejection still propagates on the returned promise.
 */
export function createDeps(opts: DepsOptions = {}) {
  const callOnError = vi.fn();
  return {
    callOnError,
    wrapLoaderPromise: vi.fn(),
    trackHandler: vi.fn((p: Promise<any>) => {
      p.catch((error) => callOnError(error, "handler", {}));
      return p;
    }),
    findNearestErrorBoundary: opts.real
      ? (entry: any) => findNearestErrorBoundary(entry)
      : () => opts.error ?? null,
    findNearestNotFoundBoundary: opts.real
      ? (entry: any) => findNearestNotFoundBoundary(entry)
      : () => opts.notFound ?? null,
    notFoundComponent: opts.notFoundComponent,
  } as any;
}

export function entryBase(overrides: Record<string, unknown>) {
  return {
    loading: "loading-fallback",
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    parent: null,
    ...overrides,
  } as any;
}

export const routeEntry = (handler: any, overrides = {}): any =>
  entryBase({ id: "r", type: "route", shortCode: "R0", handler, ...overrides });

export const parallelEntry = (handler: any, overrides = {}): any =>
  entryBase({
    id: "p",
    type: "parallel",
    shortCode: "L0P0",
    handler: { "@side": handler },
    ...overrides,
  });

export const routerCtx = { findInterceptForRoute: () => null } as any;
