/**
 * rsc-router/loader
 *
 * Client-safe createLoader implementation.
 * This file can be safely imported from both server and client contexts.
 *
 * For non-fetchable loaders: returns a stub loader definition
 * For fetchable loaders: creates a server action that can be called from client
 */

import type {
  FetchableLoaderOptions,
  LoaderActionContext,
  LoaderDefinition,
  LoaderFn,
  LoadOptions,
  MiddlewareFn,
} from "./types.js";

// Overload 1: With function, infer return type (not fetchable)
export function createLoader<T>(
  name: string,
  fn: LoaderFn<T, Record<string, string | undefined>, any>
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 2: No function (client-side reference only)
export function createLoader(
  name: string
): LoaderDefinition<any, Record<string, string | undefined>>;

// Overload 3: Fetchable with `true` (no middleware)
export function createLoader<T>(
  name: string,
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable: true
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Overload 4: Fetchable with middleware
export function createLoader<T>(
  name: string,
  fn: LoaderFn<T, Record<string, string | undefined>, any>,
  options: FetchableLoaderOptions
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>>;

// Implementation
export function createLoader<T>(
  name: string,
  fn?: LoaderFn<T, Record<string, string | undefined>, any>,
  fetchable?: true | FetchableLoaderOptions
): LoaderDefinition<Awaited<T>, Record<string, string | undefined>> {
  // If not fetchable, return a simple stub
  if (fetchable === undefined) {
    return {
      __brand: "loader",
      name,
      fn: fn as LoaderFn<Awaited<T>, Record<string, string | undefined>, any> | undefined,
    };
  }

  // Fetchable loader - create action with inline "use server"
  const middleware: MiddlewareFn<any>[] = fetchable === true ? [] : fetchable?.middleware || [];
  const loaderFn = fn!;
  const loaderMiddleware = middleware;

  const mainAction = async (options?: LoadOptions): Promise<Awaited<T>> => {
    "use server";

    // Build context
    const method = options?.method || "GET";
    const params = options?.params || {};
    const body = options && "body" in options ? options.body : undefined;

    const ctx: LoaderActionContext = {
      method,
      params,
      body,
      formData: body instanceof FormData ? body : undefined,
    };

    // Run middleware chain
    for (const mw of loaderMiddleware) {
      await mw(ctx as any, async () => {});
    }

    // Execute loader function
    return loaderFn(ctx as any) as Awaited<T>;
  };

  // Also create form action for progressive enhancement
  const formAction = async (formData: FormData): Promise<Awaited<T>> => {
    "use server";

    // Extract params from FormData
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") {
        params[key] = value;
      }
    });

    const ctx: LoaderActionContext = {
      method: "POST",
      params,
      body: formData,
      formData,
    };

    // Run middleware chain
    for (const mw of loaderMiddleware) {
      await mw(ctx as any, async () => {});
    }

    // Execute loader function
    return loaderFn(ctx as any) as Awaited<T>;
  };

  const action = mainAction as LoaderDefinition<Awaited<T>>["action"];
  action!.formAction = formAction;

  return {
    __brand: "loader",
    name,
    fn: fn as LoaderFn<Awaited<T>, Record<string, string | undefined>, any> | undefined,
    action,
  };
}
