# RSC Router Middleware Implementation Specification

This document provides a deep technical review of the middleware implementation in rsc-router.

## Table of Contents

1. [Context Creation and AsyncStore](#1-context-creation-and-asyncstore)
2. [Middleware Execution Pipeline](#2-middleware-execution-pipeline)
3. [Loader Middleware](#3-loader-middleware)
4. [Action Middleware](#4-action-middleware)
5. [Partial Renders](#5-partial-renders)
6. [Edge Cases and Error Handling](#6-edge-cases-and-error-handling)
7. [Code Quality Analysis](#7-code-quality-analysis)
8. [Test Coverage Analysis](#8-test-coverage-analysis)
9. [Demo App Analysis](#9-demo-app-analysis)
10. [Recommendations](#10-recommendations)

---

## 1. Context Creation and AsyncStore

### 1.1 Context Creation Flow

**Current Implementation:**

```
Request arrives
    ↓
variables = {} (created ONCE)
    ↓
requestContext = createRequestContext({ env, request, url, variables })
  - Creates stubResponse internally
  - Creates handleStore internally
  - Creates loaderPromises Map internally
  - Adds use() method for loader/handle composition
  - Adds all cookie/header methods
    ↓
runWithRequestContext(requestContext, async () => {...})
    ↓
All middleware, handlers, loaders access context via getRequestContext()
```

**Key Files:**

- `rsc/index.ts` - Orchestrates request handling
- `server/request-context.ts` - Context creation, AsyncLocalStorage, and `use()` implementation
- `router/handler-context.ts` - HandlerContext creation (uses `getRequestContext().var`)

### 1.2 Unified Context Architecture

**GOOD**: Context is created ONCE via `createRequestContext()` with all infrastructure:

```typescript
// server/request-context.ts
export function createRequestContext<TEnv>(
  options: CreateRequestContextOptions<TEnv>,
): RequestContext<TEnv> {
  const { env, request, url, variables } = options;

  // All infrastructure created internally
  const stubResponse = new Response(null, { status: 200 });
  const handleStore = createHandleStore();
  const loaderPromises = new Map<string, Promise<any>>();

  const ctx: RequestContext<TEnv> = {
    env,
    request,
    url,
    pathname: url.pathname,
    searchParams: url.searchParams,
    var: variables,
    get: (key) => variables[key],
    set: (key, value) => {
      variables[key] = value;
    },
    params: {},
    res: stubResponse,
    method: request.method,
    // Cookie/header methods...
    use: createUseFunction({
      handleStore,
      loaderPromises,
      getContext: () => ctx,
    }),
    _handleStore: handleStore,
  };

  return ctx;
}
```

**GOOD**: AsyncStore properly preserves context:

```typescript
// server/request-context.ts
export function runWithRequestContext<TEnv, T>(
  context: RequestContext<TEnv>,
  fn: () => T,
): T {
  return requestContextStorage.run(context, fn);
}
```

### 1.3 Context Access Pattern

**GOOD**: All code accesses context via `getRequestContext()` - no env passthrough needed:

```typescript
// router/handler-context.ts - Gets variables from request context
const requestContext = getRequestContext();
const variables: any = requestContext?.var ?? {};

// router/loader-resolution.ts - Gets handle store from request context
const getHandleStore = (): HandleStore | undefined => {
  return getRequestContext()?._handleStore;
};

// router.ts - Gets handle store for tracking
const getHandleStore = (): HandleStore | undefined => {
  return getRequestContext()?._handleStore;
};
```

This eliminates the need for `__handleStore` and `__middlewareVariables` on the env object.

---

## 2. Middleware Execution Pipeline

### 2.1 Execution Order

**Current Implementation (Onion Model):**

```
Global Middleware 1 → enters
  Global Middleware 2 → enters
    Route Middleware 1 → enters
      Route Middleware 2 → enters
        Handler executes
      Route Middleware 2 → exits
    Route Middleware 1 → exits
  Global Middleware 2 → exits
Global Middleware 1 → exits
```

**Implementation in `middleware.ts:394-479`:**

```typescript
const next = async (): Promise<Response> => {
  if (index >= middlewares.length) {
    const response = await finalHandler();
    responseHolder.response = new Response(response.body, {...});
    return responseHolder.response;
  }

  const { entry, params } = middlewares[index++];
  const ctx = createMiddlewareContext(...);

  // Handle sync next() calls
  let nextPromise: Promise<Response> | null = null;
  const wrappedNext = (): Promise<Response> => {
    nextPromise = next();
    return nextPromise;
  };

  const result = await entry.handler(ctx, wrappedNext);

  // Priority: explicit return > nextPromise > responseHolder
  if (result instanceof Response) {
    responseHolder.response = result;
    return result;
  }

  if (nextPromise) await nextPromise;

  if (responseHolder.response) return responseHolder.response;

  // Error: middleware didn't call next() or return
  throw new Error(...);
};
```

### 2.2 Middleware Types and Execution Points

| Type                | Where Defined                      | Executed By                       | Location                |
| ------------------- | ---------------------------------- | --------------------------------- | ----------------------- |
| App-level (global)  | `router.use()`                     | `executeMiddleware()`             | `rsc/index.ts:208-215`  |
| App-level (pattern) | `router.use("/path/*", mw)`        | `executeMiddleware()`             | `rsc/index.ts:208-215`  |
| Route-level         | `middleware(fn)` in route          | `executeMiddleware()`             | `rsc/index.ts:245-251`  |
| Intercept           | Inside `intercept()`               | `executeInterceptMiddleware()`    | `router.ts:1048-1056`   |
| Loader (fetchable)  | `createLoader(fn, { middleware })` | `executeLoaderMiddleware()`       | `rsc/index.ts:579-623`  |
| Server Action       | `createLoader(fn, { middleware })` | `executeServerActionMiddleware()` | `loader.rsc.ts:153-164` |

### 2.3 Stub Response Pattern

**GOOD**: Uses a "stub" Response pattern to enable `ctx.res` availability immediately:

```typescript
// Created inside createRequestContext():
const stubResponse = new Response(null, { status: 200 });

// In executeMiddleware:
const responseHolder: ResponseHolder = { response: stubResponse };
```

This allows middleware to:

1. Access `ctx.res` immediately (returns stub before `next()`, real response after)
2. Set headers before `next()` via `ctx.header()` or `ctx.res.headers.set()`
3. Set cookies before `next()` via `ctx.setCookie()` (uses `headers.append("Set-Cookie", ...)`)
4. Headers/cookies set on stub are merged into the real response after `next()` completes
5. Replace response via `ctx.res = newResponse` (setter)

**Merge Logic:** After handler returns, stub headers are merged into the real response:

- Regular headers: Use `set()` (overwrite)
- Set-Cookie headers: Use `append()` (preserve multiple cookies)

### 2.4 Response Header Merging Utility

**GOOD**: All responses use `createResponseWithMergedHeaders()` to ensure headers/cookies set during middleware are included:

```typescript
// rsc/index.ts
function createResponseWithMergedHeaders(
  body: BodyInit | null,
  init: ResponseInit,
): Response {
  const ctx = getRequestContext();
  if (!ctx) return new Response(body, init);

  // Merge headers from stub response
  const mergedHeaders = new Headers(init.headers);
  ctx.res.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      mergedHeaders.append(name, value); // Preserve multiple cookies
    } else if (!mergedHeaders.has(name)) {
      mergedHeaders.set(name, value); // Don't overwrite explicit headers
    }
  });

  return new Response(body, { ...init, headers: mergedHeaders });
}
```

This ensures headers/cookies set via `ctx.header()` or `ctx.setCookie()` in middleware are included in:

- RSC stream responses
- HTML responses
- Redirect responses
- Error responses
- Loader responses

**Example:**

```typescript
const middleware: MiddlewareFn = async (ctx, next) => {
  // Set headers/cookies BEFORE next() - applied to stub, merged into real response
  ctx.header("X-Request-Id", generateId());
  ctx.setCookie("session", "abc123", { httpOnly: true });

  await next();

  // Set headers/cookies AFTER next() - applied directly to real response
  ctx.header("X-Timing-End", Date.now().toString());
};
```

---

## 3. Loader Middleware

### 3.1 Fetchable Loader Middleware (GET/POST-based)

**Location:** `rsc/index.ts`

```typescript
return await executeLoaderMiddleware(
  middleware,
  request,
  env,
  loaderParams,
  requireRequestContext().var, // Variables from unified context
  requireRequestContext().res, // Stub response for header merging
  async () => {
    // Loader executes within request context
    // Variables accessed via getRequestContext().var
    return fn(loaderContext);
  },
);
```

**GOOD**: Uses `executeLoaderMiddleware()` which wraps `executeMiddleware()`:

```typescript
// middleware.ts
export async function executeLoaderMiddleware<TEnv>(
  middlewares: MiddlewareFn<TEnv>[],
  request: Request,
  env: TEnv,
  params: Record<string, string>,
  variables: Record<string, any>,
  stubResponse: Response,
  finalHandler: () => Promise<Response>,
): Promise<Response> {
  if (middlewares.length === 0) {
    return finalHandler();
  }

  // Convert to MiddlewareEntry format
  const middlewareEntries = middlewares.map((handler) => ({
    entry: {
      pattern: null,
      regex: null,
      paramNames: [],
      handler,
      mountPrefix: null,
    },
    params,
  }));

  return executeMiddleware(
    middlewareEntries,
    request,
    env,
    variables,
    stubResponse,
    finalHandler,
  );
}
```

### 3.2 Server Action Middleware

**Location:** `loader.rsc.ts:150-164`

```typescript
if (registered.middleware.length > 0) {
  await executeServerActionMiddleware(
    registered.middleware,
    actionRequest,
    env,
    params,
    variables,
  );
}
```

**IMPORTANT**: Server actions CANNOT return Response:

```typescript
// middleware.ts:526-533
if (result instanceof Response) {
  throw new Error(
    `Loader middleware returned a Response (status: ${result.status}). ` +
      `Server actions cannot return Response. ` +
      `Use GET-based loader fetching for redirects, or throw an error instead.`,
  );
}
```

---

## 4. Action Middleware

### 4.1 Server Action Context

**Location:** `rsc/index.ts:287-393`

Server actions run within the existing request context but:

1. Do NOT have their own middleware execution
2. Inherit app-level middleware context from `getRequestContext()`
3. Can trigger loader middleware if using fetchable loaders

**Middleware-Action Relationship:**

```
Request arrives
  ↓
App middleware executes (sets ctx.var.user = ...)
  ↓
Route middleware executes
  ↓
Server action triggered
  ↓
getRequestContext() returns context with user
  ↓
Loader middleware executes (if fetchable)
  ↓
Loader function executes
```

---

## 5. Partial Renders

### 5.1 Middleware Execution During Partial Renders

**Location:** `rsc/index.ts:401-503`

During partial renders (navigation, action revalidation):

1. **App-level middleware**: Runs (same as full render)
2. **Route-level middleware**: Runs via `previewMatch()`
3. **Intercept middleware**: Runs if intercept matches (`executeInterceptMiddleware()`)

```typescript
// router.ts:1048-1056
if (interceptEntry.middleware.length > 0) {
  const middlewareResponse = await executeInterceptMiddleware(
    interceptEntry.middleware,
    context.request,
    context.env,
    params,
    context.var as Record<string, any>,
  );
  if (middlewareResponse) throw middlewareResponse;
}
```

### 5.2 Intercept Middleware Special Handling

**FIXED**: `executeInterceptMiddleware()` now works correctly:

1. **Cookies are properly applied:**

```typescript
// Cookies collected via ctx.setCookie() are applied to early response
if (earlyResponse) {
  return applyPendingCookies(earlyResponse, pendingCookies);
}
```

2. **ctx.res is available after next():**

```typescript
// Uses stubResponse passed from request context
const responseHolder: ResponseHolder = { response: stubResponse };
// After next(), responseHolder.response is properly set
```

3. **ctx.header() works correctly:**
   After `next()`, `ctx.header()` sets headers on the real response.

**Behavior matches normal middleware:**

- Cookies ARE applied via `applyPendingCookies()`
- `ctx.res` IS available after `next()`
- `ctx.header()` works as expected

---

## 6. Edge Cases and Error Handling

### 6.1 Premature Return Handling

**Tested scenarios:**

| Return Type                 | Behavior                         | Status    |
| --------------------------- | -------------------------------- | --------- |
| `Response` object           | Short-circuits, returns response | GOOD      |
| `undefined` (via no return) | Uses `ctx.res` if available      | GOOD      |
| `void` (explicit return;)   | Uses `ctx.res` if available      | GOOD      |
| `Promise<undefined>`        | Uses `ctx.res` if available      | GOOD      |
| Any other value             | UNKNOWN - No explicit handling   | **ISSUE** |

**ISSUE IDENTIFIED**: Non-Response return values are not explicitly handled:

```typescript
// middleware.ts:443-447
const result = await entry.handler(ctx, wrappedNext);

if (result instanceof Response) {
  responseHolder.response = result;
  return result;
}
// Any other non-undefined return is silently ignored!
```

**RECOMMENDATION**: Add validation for unexpected return types:

```typescript
if (result !== undefined && !(result instanceof Response)) {
  console.warn(`Middleware returned unexpected value: ${typeof result}`);
}
```

### 6.2 Sync vs Async Middleware

**GOOD**: Both sync and async middleware are handled:

```typescript
// middleware.ts:433-439
let nextPromise: Promise<Response> | null = null;
const wrappedNext = (): Promise<Response> => {
  nextPromise = next();
  return nextPromise;
};

// Later:
if (nextPromise) {
  await nextPromise;
}
```

This handles cases like:

```typescript
// Sync middleware - doesn't await
(ctx, next) => {
  next();
};

// Async middleware - awaits
async (ctx, next) => {
  await next();
};
```

### 6.3 Middleware Not Calling next()

**GOOD**: Proper error handling:

```typescript
// middleware.ts:459-466
throw new Error(
  `Middleware must call next() or return a Response. ` +
    `Function: ${fnName}, Pattern: ${entry.pattern ?? "(all)"}
  Source: ${import.meta.env.DEV ? entry.handler.toString().slice(0, 200) : "(source hidden in production)"}`,
  { cause: { url: request.url, fn: entry.handler } },
);
```

### 6.4 ctx.res Access Before next()

**GOOD**: Clear error message:

```typescript
// middleware.ts:270-275
get res(): Response {
  if (!responseHolder.response) {
    throw new Error(
      "ctx.res is not available until after await next() is called"
    );
  }
  return responseHolder.response;
}
```

---

## 7. Code Quality Analysis

### 7.1 Maintainability

**GOOD:**

- Clear separation: `middleware.ts` handles all middleware logic
- Well-documented interfaces with JSDoc comments
- Type-safe context with generics
- Consistent naming conventions

**CONCERNS:**

- `executeMiddleware`, `executeLoaderMiddleware`, `executeServerActionMiddleware`, `executeInterceptMiddleware` have similar but subtly different logic - potential for bugs when modifying one but not others
- Some logic duplication in route middleware collection (`collectEntryMiddleware` defined 3 times in router.ts)

### 7.2 Readability

**GOOD:**

- Clear function names
- Descriptive variable names
- Logical code flow

**CONCERNS:**

- `rsc/index.ts` is very long (820+ lines) - middleware orchestration mixed with RSC rendering logic
- Some deeply nested callbacks (e.g., loader middleware execution)

### 7.3 Type Safety

**GOOD:**

- Generic middleware types: `MiddlewareFn<TEnv, TParams>`
- Typed context: `MiddlewareContext<TEnv, TParams>`
- Proper type inference for route params

**CONCERNS:**

- Some `any` types in handler-context.ts
- `ctx.get()` returns `any` - could be more strictly typed

### 7.4 Performance Considerations

**GOOD:**

- Lazy cookie parsing (only when accessed)
- Short-circuit on early Response return
- No unnecessary cloning of context

**POTENTIAL OPTIMIZATION:**

- Pattern regex compilation happens on every `.use()` call but could be memoized
- Response cloning in `executeMiddleware` could be avoided in some cases

---

## 8. Test Coverage Analysis

### 8.1 Unit Tests (`middleware.test.ts`)

**Covered:**

- [x] Pattern parsing (_, /path, /path/_, /path/:param, /path/:param/\*)
- [x] Parameter extraction (single, multiple)
- [x] Cookie parsing/serialization
- [x] Middleware matching (global, pattern-based)
- [x] Execution order
- [x] ctx.res access after next()
- [x] ctx.header() shorthand
- [x] Short-circuit on Response return
- [x] Error catching from handler
- [x] Variable sharing
- [x] Cookie read/set/delete
- [x] Error on no next() call
- [x] Error on ctx.res before next()
- [x] Response replacement via ctx.res setter

**COVERED (ADDED):**

- [x] `executeLoaderMiddleware()` unit tests (7 tests)
- [x] `executeServerActionMiddleware()` unit tests (8 tests)
- [x] `executeInterceptMiddleware()` unit tests (15 tests)
- [x] Non-Response return value handling (warning logged)
- [x] Sync middleware support (tested)
- [x] Multiple middleware chaining (tested)

**REMAINING GAPS:**

- [ ] Response body streaming with middleware (E2E)

### 8.2 E2E Tests (`app-middleware.test.ts`)

**Covered:**

- [x] Global headers on all routes
- [x] Pattern-based middleware matching
- [x] Parameter extraction from URL
- [x] Auth redirect (cookie-based)
- [x] Error handling middleware (headers applied despite errors)
- [x] Cookie increment across requests
- [x] Variable sharing with handlers
- [x] Multiple middleware chaining
- [x] Production mode testing

**MISSING:**

- [ ] Route-level middleware (defined via `middleware()` in handlers)
- [ ] Intercept middleware
- [ ] Loader middleware (fetchable loaders)
- [ ] Server action middleware
- [ ] Partial render middleware execution
- [ ] Middleware with Response.redirect() vs `redirect()` helper
- [ ] Streaming response with middleware headers
- [ ] Error boundary interaction with middleware

---

## 9. Demo App Analysis

### 9.1 Current Middleware Usage

**Test App (`e2e/test-app/src/router.tsx`):**

- Global middleware (3): timing, headers, shorthand
- Pattern middleware (4): auth, error handler, cookies, params
- Well-structured, good examples

**Demo App (`examples/vite-rsc-demo/src/handlers/`):**

- `dashboard.tsx`: Rate limit, analytics middleware
- `protected.tsx`: Auth redirect middleware
- Limited variety of middleware patterns

### 9.2 Missing Demo Patterns

- [ ] Loader middleware example
- [ ] Server action middleware with auth
- [ ] Intercept middleware
- [ ] Error handling middleware with custom error pages
- [ ] Request logging/tracing middleware
- [ ] CORS middleware
- [ ] Response compression middleware
- [ ] Cache-control header middleware

---

## 10. Recommendations

### 10.1 Critical Fixes (BUGS) - ALL FIXED

1. ~~**BUG: Intercept middleware cookies are silently dropped**~~
   **FIXED:** Cookies are now applied via `applyPendingCookies()` before returning early response.

2. ~~**BUG: Server action middleware cookies are silently dropped**~~
   **FIXED:** Throws clear error explaining server actions cannot set cookies. Error message guides user to use GET-based loader fetching instead.

3. ~~**BUG: Intercept middleware cannot access ctx.res after next()**~~
   **FIXED:** `stubResponse` is passed from request context and properly set in `responseHolder`.

4. ~~**ISSUE: Non-Response return values are silently ignored**~~
   **FIXED:** Logs warning when middleware returns unexpected value type.

5. ~~**BUG: Intercept middleware headers set after next() cause short-circuit**~~
   **FIXED:** Modified `executeInterceptMiddleware()` to accept a `stubResponse` parameter from the request context. Headers set after `next()` remain on the stubResponse and are merged into the final response by the caller. Only explicit short-circuits (middleware returning Response BEFORE `next()`) cause an abort.

### 10.2 Code Quality Improvements

1. ~~**Extract route middleware collection logic**~~
   **DONE:** Created shared `collectRouteMiddleware()` function in `middleware.ts`.

2. ~~**Unify context architecture**~~
   **DONE:** All context created via `createRequestContext()`, accessed via `getRequestContext()`. Removed `__handleStore` and `__middlewareVariables` env passthrough.

3. ~~**Response header merging**~~
   **DONE:** Created `createResponseWithMergedHeaders()` utility to ensure headers/cookies set in middleware are included in all responses.

4. **Split rsc/index.ts:** (Open)
   Consider splitting middleware orchestration into a separate file to improve maintainability.

5. **Add stricter types for ctx.get/set:** (Open)

```typescript
interface TypedVariables {
  user?: { id: string; name: string };
  visitCount?: number;
  // ...
}
get<K extends keyof TypedVariables>(key: K): TypedVariables[K];
```

### 10.3 Additional Unit Tests - DONE

All unit tests implemented (75 tests in `middleware.test.ts`):

1. ~~`executeLoaderMiddleware()`~~ **DONE** (7 tests):
   - With empty middleware array
   - With single middleware
   - With multiple middleware
   - Short-circuit behavior
   - Cookie/header handling

2. ~~`executeServerActionMiddleware()`~~ **DONE** (8 tests):
   - With empty middleware array
   - Response return error handling
   - Variable sharing
   - Cookie error handling (throws clear error)

3. ~~`executeInterceptMiddleware()`~~ **DONE** (15 tests):
   - Short-circuit behavior
   - Variable sharing
   - Error handling
   - Cookie/header handling

### 10.4 E2E Test Actions - DONE

All middleware E2E tests implemented in `e2e/app-middleware.test.ts`:

- Route-level middleware with params
- Loader middleware auth scenarios
- Intercept middleware headers and cookies

#### Test App Changes Needed

**1. Add route-level middleware to handlers.tsx:**

```typescript
// In handlers.tsx, add a route with middleware()
import { middleware } from "rsc-router";

// Add this to the route definition
export const RouteLevelMiddlewareTest = () => {
  return (
    <>
      {middleware(async (ctx, next) => {
        await next();
        ctx.header("X-Route-Level-Middleware", "applied");
      })}
      <div data-testid="route-middleware-page">Route with middleware</div>
    </>
  );
};
```

**2. Add route to routes.ts:**

```typescript
routeLevelMiddleware: "/route-level-middleware",
```

**3. Add intercept with middleware to router.tsx:**

```typescript
// Add intercept with middleware for testing
.intercept("@modal", "slowProduct.detail", <ProductModal />, () => [
  middleware(async (ctx, next) => {
    await next();
    ctx.header("X-Intercept-Middleware", "applied");
  }),
])
```

#### E2E Tests to Add (`e2e/middleware-features.test.ts`)

```typescript
test.describe("middleware-features", () => {
  // 1. Route-level middleware
  test("route-level middleware should add headers", async ({ page }) => {
    const response = await page.goto(f.url("/route-level-middleware"));
    expect(response.headers()["x-route-level-middleware"]).toBe("applied");
  });

  // 2. Fetchable loader middleware - auth success
  test("loader middleware should allow access with valid token", async ({
    page,
  }) => {
    // ProtectedLoader already has middleware checking authToken param
    await page.goto(f.url("/hook-tests"));
    // Use the ProtectedLoader with valid token
    await page.fill('[data-testid="auth-token-input"]', "valid-token");
    await page.click('[data-testid="fetch-protected-btn"]');
    await expect(page.locator('[data-testid="protected-data"]')).toContainText(
      "protected data",
    );
  });

  // 3. Fetchable loader middleware - auth failure
  test("loader middleware should reject invalid token", async ({ page }) => {
    await page.goto(f.url("/hook-tests"));
    await page.fill('[data-testid="auth-token-input"]', "invalid-token");
    await page.click('[data-testid="fetch-protected-btn"]');
    await expect(page.locator('[data-testid="loader-error"]')).toContainText(
      "Unauthorized",
    );
  });

  // 4. Server action middleware (form-based loader)
  test("server action middleware should validate auth", async ({ page }) => {
    await page.goto(f.url("/hook-tests/form-action"));
    // Submit form without auth token
    await page.click('[data-testid="submit-protected-form"]');
    await expect(page.locator('[data-testid="form-error"]')).toContainText(
      "Unauthorized",
    );
  });

  // 5. Partial render middleware
  test("middleware should execute during soft navigation", async ({ page }) => {
    await page.goto(f.url("/middleware-test"));
    await waitForHydration(page);

    // Navigate using Link (soft navigation)
    const responsePromise = page.waitForResponse((r) =>
      r.url().includes("/middleware-test/params/nav-test"),
    );
    await page.click('[data-testid="link-to-params"]');
    const response = await responsePromise;

    // Global middleware should still apply on partial response
    expect(response.headers()["x-global-middleware"]).toBe("applied");
    expect(response.headers()["x-middleware-param-id"]).toBe("nav-test");
  });

  // 6. Intercept middleware (after bug fix)
  test("intercept middleware should set headers", async ({ page }) => {
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    // Click to open intercept modal
    const responsePromise = page.waitForResponse((r) =>
      r.url().includes("/slow-product/slow-product-a"),
    );
    await page.click('[data-testid="product-link"]');
    const response = await responsePromise;

    expect(response.headers()["x-intercept-middleware"]).toBe("applied");
  });

  // 7. Intercept middleware cookies (after bug fix)
  test("intercept middleware should set cookies", async ({ page, context }) => {
    await page.goto(f.url("/shop"));
    await waitForHydration(page);

    await page.click('[data-testid="product-link"]');

    // Check that cookie was set by intercept middleware
    const cookies = await context.cookies();
    const interceptCookie = cookies.find((c) => c.name === "intercept-visit");
    expect(interceptCookie).toBeDefined();
  });
});
```

#### Summary of Test Coverage

| Feature                            | Current Coverage | Status                                                          |
| ---------------------------------- | ---------------- | --------------------------------------------------------------- |
| App-level global middleware        | ✅ Full          | E2E tests in `app-middleware.test.ts`                           |
| App-level pattern middleware       | ✅ Full          | E2E tests in `app-middleware.test.ts`                           |
| Route-level middleware             | ✅ Full          | Tests for headers, variable sharing, and ctx.params access      |
| Route-level middleware with params | ✅ Full          | Tests verify ctx.params is typesafe and available in middleware |
| Fetchable loader middleware        | ✅ Full          | Tests for auth success, rejection, and invalid token            |
| Server action middleware           | ⚠️ Partial       | Throws error on cookie set (intended limitation)                |
| Partial render middleware          | ✅ Full          | Covered by soft navigation tests                                |
| Intercept middleware headers       | ✅ Full          | Tests verify headers set after next() are merged                |
| Intercept middleware cookies       | ✅ Full          | Tests verify cookies set after next() are applied               |

### 10.5 Demo App Enhancements

1. Add a `middleware-examples.tsx` handler showcasing:
   - Loader middleware for auth
   - Server action with protected loader
   - Request timing/logging
   - Response header manipulation

2. Add to shop demo:
   - Cart loader with auth middleware
   - Checkout action with validation middleware

---

## Summary

### Critical Bugs Found

| Bug                                    | Severity | Location                          | Impact                                                                                  | Status    |
| -------------------------------------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------- | --------- |
| ~~Intercept cookies dropped~~          | HIGH     | `executeInterceptMiddleware()`    | ~~Cookies set in intercept middleware are silently ignored~~                            | **FIXED** |
| ~~Server action cookies dropped~~      | MEDIUM   | `executeServerActionMiddleware()` | ~~Cookies set in server action middleware are silently ignored~~ Now throws clear error | **FIXED** |
| ~~Intercept ctx.res unavailable~~      | MEDIUM   | `executeInterceptMiddleware()`    | ~~Cannot modify response headers in intercept middleware~~                              | **FIXED** |
| ~~Non-Response returns ignored~~       | LOW      | `executeMiddleware()`             | ~~User errors go undetected~~ Now logs warning                                          | **FIXED** |
| ~~Intercept middleware short-circuit~~ | HIGH     | `executeInterceptMiddleware()`    | ~~Headers set after next() break intercept flow~~                                       | **FIXED** |

### Architecture Improvements

| Improvement      | Description                                                                                            | Status   |
| ---------------- | ------------------------------------------------------------------------------------------------------ | -------- |
| Unified Context  | All context created via `createRequestContext()` with handleStore, loaderPromises, use(), stubResponse | **DONE** |
| Context Access   | All code uses `getRequestContext()` - no `__handleStore`/`__middlewareVariables` env passthrough       | **DONE** |
| Response Merging | `createResponseWithMergedHeaders()` ensures headers/cookies in all responses                           | **DONE** |
| use() Method     | `RequestContext.use()` for loader/handle composition available everywhere                              | **DONE** |
| method Property  | `RequestContext.method` for global HTTP method access                                                  | **DONE** |

### What Works Well

- Context is created ONCE via `createRequestContext()` with all infrastructure
- All code accesses context via `getRequestContext()` - clean architecture
- `createResponseWithMergedHeaders()` ensures headers/cookies are never lost
- Onion model execution is correct
- Sync and async middleware both work
- Good error messages for common mistakes (next() not called, ctx.res before next())
- Comprehensive unit tests (75 tests in middleware.test.ts)
- Good E2E coverage for app-level middleware

### Areas for Improvement

1. ~~**Critical Bugs**: Cookies and ctx.res issues in intercept/action middleware~~ **FIXED**
2. ~~**Edge Cases**: Non-Response return values silently ignored~~ **FIXED**
3. ~~**Code Duplication**: `collectEntryMiddleware` defined 3 times~~ **FIXED**
4. **Test Coverage**: E2E tests for loader/action/intercept middleware (unit tests done)
5. **Demo Coverage**: Limited middleware examples in demo apps

### Priority Actions

| Priority | Action                                                              | Effort | Status              |
| -------- | ------------------------------------------------------------------- | ------ | ------------------- |
| ~~P0~~   | ~~Fix intercept middleware cookie handling~~                        | Low    | **DONE**            |
| ~~P0~~   | ~~Fix intercept ctx.res limitation~~                                | Low    | **DONE**            |
| ~~P1~~   | ~~Decide on server action middleware cookies~~ - throws clear error | Medium | **DONE**            |
| ~~P1~~   | ~~Add unit tests for all execute\* functions~~                      | Medium | **DONE** (75 tests) |
| ~~P1~~   | ~~Unify context architecture~~                                      | Medium | **DONE**            |
| ~~P2~~   | ~~Add validation for non-Response return values~~ - logs warning    | Low    | **DONE**            |
| ~~P2~~   | ~~Refactor duplicate `collectEntryMiddleware`~~                     | Low    | **DONE**            |
| ~~P2~~   | ~~Add `createResponseWithMergedHeaders()` utility~~                 | Low    | **DONE**            |
| P3       | Add E2E tests for route-level and loader middleware                 | Medium | Open                |
| P3       | Add more middleware examples to demo apps                           | Low    | Open                |
