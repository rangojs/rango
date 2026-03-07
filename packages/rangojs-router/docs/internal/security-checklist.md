# Security Checklist

Use this checklist for any router change that adds or changes execution paths,
transport behavior, or request/response ownership.

## Scope

- Does the change affect JS actions, PE form submissions, loaders, middleware,
  response routes, redirects, or prerender/static paths?
- Does it introduce a new execution mode, cache layer, or request boundary?
- Does it change which code owns the final `Response`?

## Auth And Action Exposure

- Are actions authenticated and authorized explicitly?
- Are route middleware expectations still correct for actions?
- Could the change expose an action over a transport that bypasses an auth
  check present elsewhere?
- Are response routes and non-HTML endpoints covered by the same auth model?

## Redirects

- Are redirect targets validated or constrained to trusted routes/origins?
- Do redirects preserve the intended cookies and headers?
- Does the redirect path behave the same in JS and PE flows?
- Is any render-only state being relied on across a redirect?

## Cookies And Headers

- Which layer owns cookie and header mutations: middleware, action, handler, or
  response route?
- Are those mutations preserved in the final `Response` for all success,
  redirect, error-boundary, and PE paths?
- Could cookies or headers be duplicated, dropped, or overwritten by a later
  response owner?

## Request Context Isolation

- Does request-scoped state stay isolated across concurrent requests?
- Are `getRequestContext()`, `ctx.set()/ctx.get()`, cookies, headers, and
  onResponse callbacks preserved across async boundaries without leaking?
- Are any background tasks or deferred callbacks reading request context after
  the request should be considered finished?

## Cache And Multi-Tenant Boundaries

- Can cache keys vary by user, host, locale, auth state, or request type when
  they need to?
- Could prerender/runtime cache entries leak across hosts, users, or response
  variants?
- Are content-negotiated and response-route variants separated correctly?

## Response Ownership And Negotiation

- Is it clear whether document rendering, response routes, middleware, or
  redirects own the final response?
- Are HTML, RSC, JSON, and partial/document negotiation paths still aligned?
- Could a non-HTML or partial request accidentally fall through to the wrong
  response owner?

## Test Requirement

- Add or update a regression test for every security-relevant fix.
- Prefer targeted concurrency tests for request-context isolation.
- Prefer transport-paired tests when behavior differs between JS and PE.
- If the change touches redirects/cookies/headers, test both success and
  redirect/error paths.

## Phase 5 Regression Coverage

The following e2e suites were added during Phase 5 security hardening. Each
suite runs in both dev and production modes.

### Auth Boundary (`e2e/auth-boundary.test.ts`)

Proves which middleware layer guards which execution phase:

- Route middleware rejects unauthenticated document requests (redirect).
- Route middleware does NOT guard action execution (by design).
- Global middleware guards both document requests and action execution.
- Response routes with route middleware enforce auth independently.
- PE action variant follows the same auth boundary rules.

Bug found and fixed: middleware redirects on action requests caused `fetch()`
to follow the 302 and re-execute the action at the redirect target URL because
the `rsc-action` header was preserved. Fix: intercept 3xx redirects for
`_rsc_action` requests (convert to 204 with `X-RSC-Redirect`).

### Content Ownership (`e2e/content-ownership.test.ts`)

Proves which pipeline (response route vs RSC document) owns a given request:

- Accept header selects document vs JSON pipeline correctly.
- `Vary: Accept` is set on all negotiated responses.
- Partial requests to response routes return `X-RSC-Reload`, not handler data.
- Response route errors stay as JSON errors, not document shells.
- Guarded response routes reject without leaking protected payload.
- Middleware redirects on response routes fire without returning handler body.

### Cache Isolation (`e2e/cache-isolation.test.ts`)

Proves cached responses do not leak across request boundaries:

- Different query params produce separate cache entries.
- Custom `key()` isolates authenticated vs anonymous responses.
- Default cache key (no auth isolation) shares entries across auth states (by
  design — proves the need for custom keys).
- `condition()` skips cache for specific requests (e.g. authenticated users).
- `onResponse` pre-handler callbacks produce fresh values per serve.

Bug found and fixed: response route caching ignored `condition()` callbacks.
The `condition()` check only existed in `CacheScope` (document cache), not in
the response route cache path in `response-route-handler.ts`. Fix: added
condition evaluation before entering the response cache read/write block.

### Unit Coverage (`response-route-handler.test.ts`)

Targeted unit tests for the `condition()` fix:

- `condition() === false` skips cache read (store.getResponse not called).
- `condition() === false` skips cache write (store.putResponse not called).
- `condition() === true` uses cache normally (cache hit returned).
