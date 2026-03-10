# Runtime Guardrails: Warning Design

Status: Partial (W1, W3, W5 shipped; W2 reframed as docs/tests contract;
W4, W6 deferred — see stability-roadmap.md Phase 3)

Design doc for Phase 3 of stability-roadmap.md (line 126).
Goal: dev-mode warnings that surface likely misuse before it ships.

Principle: warn, never silently fix. Warnings fire only in dev mode
(`import.meta.env.DEV` or `INTERNAL_RANGO_DEBUG`).

---

## W1: Route middleware used as action guard

### Trigger condition

A route middleware calls `ctx.set()`, sets headers/cookies, or returns an
early Response on a route that also defines server actions — and the user
expects that middleware to run _before_ the action executes.

Route middleware wraps the render pass only. Actions execute first, outside
route middleware scope (`handler.ts:418-447`). The middleware then wraps the
post-action revalidation render (`handler.ts:449-491`). For PE, the same
pattern holds (`progressive-enhancement.ts:176-190`).

### Where detection happens

**Static analysis at route build time** (in Vite plugin or `match()` setup):
when a route entry has both `middleware` and action-capable handlers, emit
a one-time dev warning.

Alternatively, **runtime detection in `handler.ts`**: when `isAction && actionId`
is true and `preview.routeMiddleware.length > 0`, log a warning on the first
occurrence per route.

Preferred: runtime detection in `handler.ts`, gated behind dev mode. Simpler,
no false positives from routes that have middleware but never receive actions.

### Warning text

```
[rango] Route middleware does not guard server actions. The action at
"<actionId>" executed before route middleware ran. Route middleware only
wraps the render/revalidation pass. To guard actions, use global middleware
or validate inside the action itself. See: execution-model.md#non-guarantees
```

### Confidence / false-positive risk

**High confidence, low false-positive risk.** The warning only fires when an
action actually executes on a route with middleware — a concrete event, not
a static guess. The only "false positive" is a user who knowingly uses
middleware for render-only concerns on an action route, which is valid but
uncommon enough that a one-time warning is acceptable.

Mitigation: fire once per route per process (deduplicate by route key).

### Tests needed

1. Unit test: action on route with middleware triggers warning (console spy).
2. Unit test: action on route without middleware does not warn.
3. Unit test: warning fires only once per route key (deduplication).
4. E2e: semantic-matrix row confirming action executes before middleware.

---

## W2: Child reads upstream context that won't revalidate

### Decision

**Do not implement as a runtime warning.**

### Rationale

For the producer/consumer contract case, the observed failure mode is not a
hidden stale carry-over. During partial action revalidation, non-revalidated
ancestors do not rerun to rebuild `ctx.set()` state, so downstream consumers
see missing/`undefined` data unless the producer shares the same revalidation
contract.

That means the app-level failure is already explicit:

- the producer did not rerun
- the consumer did rerun
- the consumer sees missing upstream data

Adding freshness tracking and stable-var metadata would add meaningful
complexity for limited benefit if the runtime is not actually surfacing a
misleading retained value.

### Hardening strategy

Instead of a warning:

1. Keep the execution-model docs explicit about the contract.
2. Add a semantic-matrix row that proves the consumer sees missing data when
   the producer does not rerun.
3. Keep the checklist wording sharp so reviews treat this as a semantic
   contract, not a future runtime fix.

Revisit only if a concrete hidden stale-read case is reproduced in the real
request pipeline.

---

## W3: PE/JS response shape divergence

### Trigger condition

The same action produces different response behavior depending on whether
the request came from a JavaScript-enabled client (Flight payload) or a
progressive enhancement form submission (full HTML re-render).

JS path: `handler.ts:418-447` executes action, then `449-491` renders
Flight payload wrapped in route middleware.

PE path: `progressive-enhancement.ts:77-113` executes action, then
`128-192` re-renders full HTML page wrapped in route middleware.

Both paths execute actions and wrap rendering with middleware identically,
so the _rendering_ is consistent. The divergence risk is in **action return
values**: if an action returns data that the JS path uses for optimistic UI
but the PE path ignores (or vice versa), behavior diverges.

### Where detection happens

**Runtime in `progressive-enhancement.ts`**: after action execution, compare
the action result type/shape to what the JS path would produce. This is
hard to do without running both paths.

**Alternative (practical)**: detect when an action returns a Response object
(redirect) in one path but not the other. Specifically, in
`progressive-enhancement.ts`, if the action result is a Response, it's
currently silently ignored (the page re-renders from scratch). In the JS
path (`handler.ts:434`), a Response result short-circuits the whole flow.

Preferred: warn in `progressive-enhancement.ts` when the action result is
a Response instance, since PE silently drops it.

### Warning text

```
[rango] Server action returned a Response object during progressive
enhancement (no-JS) request. The redirect/response will be ignored — the
page will re-render at the current URL instead. To handle PE redirects,
use redirect() in the action. See: progressive-enhancement docs
```

### Confidence / false-positive risk

**High confidence, low false-positive risk.** A Response return from an
action during PE is objectively dropped. This is always a bug or
misunderstanding.

### Tests needed

1. Unit test: action returning Response during PE triggers warning.
2. Unit test: action returning plain data during PE does not warn.
3. E2e: PE form submission with redirect action — verify warning + behavior.

---

## W4: Conflicting cache and revalidation settings

### Trigger condition

A route entry has both `cache()` config and `revalidate()` rules that
contradict each other. Examples:

- `cache({ ttl: 3600 })` with `revalidate(() => true)` (always revalidate
  defeats the purpose of caching).
- `cache(false)` (explicitly disabled) on a parent, but a child's
  `revalidate()` references the parent expecting cached data.
- Very short TTL (< 5s) combined with SWR window (stale data served but
  immediately revalidated — functionally equivalent to no cache).

### Where detection happens

**Route build time** (in `createCacheScope()` or match pipeline setup):
when both cache config and revalidation rules are present on the same
entry, validate compatibility.

`cache-scope.ts:104-118` creates the scope with config. The revalidation
rules are evaluated later in `evaluateRevalidation()`. Detection would need
to happen where both are visible — in the match pipeline
(`match-middleware/cache-lookup.ts` + `revalidation.ts`).

Preferred: in the match pipeline during the first request to a route,
compare the cache config and revalidation rules. Log once per route.

### Warning text

```
[rango] Route "<routeKey>" has cache(ttl=<N>) but revalidate() always
returns true. Every request will bypass cache and re-render. Consider
removing cache() or adjusting the revalidation rule.
```

### Confidence / false-positive risk

**Medium confidence, medium false-positive risk.** "Always returns true"
requires evaluating the revalidation function, which may depend on runtime
state. Static analysis of the function body is impractical.

Mitigations:

- Only flag the _result_ after evaluation: if the first N requests to a
  cached route all result in revalidation=true, warn.
- Track hit/miss ratio per cache scope; warn when miss ratio > 95% after
  a reasonable sample (e.g., 10 requests).

This is lower priority due to complexity. Consider deferring to Phase 4
(observability) where cache hit/miss metrics would surface this naturally.

### Tests needed

1. Unit test: `cache()` + always-true `revalidate()` triggers warning after N requests.
2. Unit test: `cache()` + selective `revalidate()` does not warn.
3. Unit test: `cache(false)` does not interact with revalidation warnings.

---

## W5: Redirect after ctx.set() discards render-only state

### Trigger condition

A route middleware calls `ctx.set()` to provide data for the render pass,
then returns a redirect (early Response with 3xx status). The redirect
skips rendering entirely, so the context variables are never consumed.
If the user intended the data to be available after redirect, it won't be —
`ctx.set()` values are per-request and do not survive redirects.

Note: `ctx.header()` and `ctx.cookie()` mutations are NOT affected.
`executeMiddleware()` explicitly merges stub headers (including Set-Cookie)
into middleware-returned Responses (`middleware.ts:322-352`). Only
`ctx.set()` render-scoped state is lost.

### Where detection happens

**Runtime in `executeMiddleware()`**: after a middleware returns a Response
(the short-circuit path at `middleware.ts:322`), check if the variables
object gained new entries during this middleware pass. If the Response is a
redirect (3xx) and variables were set, warn.

Track this by snapshotting `Object.keys(variables).length` (plus symbol
count) before executing the middleware chain. After short-circuit, compare.

### Warning text

```
[rango] Route middleware on "<routeKey>" called ctx.set() then returned a
redirect. Context variables are per-request and won't be available on the
redirect target. Use cookies to persist state across redirects, or move
ctx.set() to the target route's middleware.
```

### Confidence / false-positive risk

**Medium confidence, low false-positive risk.** Setting render-scoped state
then redirecting is almost always a mistake — the render never runs to
consume it. The only edge case is middleware that sets variables
"speculatively" before deciding to redirect, which is unusual but valid.

Mitigations:

- Only warn for `ctx.set()` + redirect, not for `ctx.header()`/`ctx.cookie()`.
- Fire once per route key per process.

### Tests needed

1. Unit test: `ctx.set()` + redirect triggers warning.
2. Unit test: `ctx.cookie()` + redirect does not warn.
3. Unit test: `ctx.header()` + redirect does not warn.
4. Unit test: redirect without `ctx.set()` does not warn.
5. E2e: middleware redirect after setting context — verify warning.

---

## W6: Action mutates cookies/headers but return flow drops them

### Trigger condition

A server action calls `ctx.cookie()` or `ctx.header()` to set response
headers, but the action's return flow (redirect, error boundary, or
revalidation render) doesn't preserve those headers in the final Response.

In the JS path (`handler.ts:418-447`), if the action returns a Response
(redirect), headers set via `ctx.header()` on the handler context may not
be merged into that Response. In the PE path, the re-render creates a fresh
Response (`progressive-enhancement.ts:171-173`) that may not include
headers set during action execution.

### Where detection happens

**Runtime in `handler.ts`** after action execution: compare headers/cookies
set on the handler context during action execution with headers present on
the final Response. If any are missing, warn.

This requires tracking which headers were set during the action phase
(before render) vs during the render phase.

Preferred: instrument the handler context to track "action-phase" header
mutations separately. After the final response is built, check if any
action-phase headers are missing.

### Warning text

```
[rango] Server action set header "<headerName>" via ctx.header(), but the
header is not present in the final response. Headers set during action
execution may be dropped during redirect or revalidation. Set headers in
route middleware (which wraps the render) or use ctx.cookie() for values
that must survive redirects.
```

### Confidence / false-positive risk

**Low-medium confidence, medium false-positive risk.** Some headers are
intentionally ephemeral (set for debugging, logging). The action may set a
header that the render phase intentionally overrides.

This is the most complex guardrail to implement correctly. Consider
deferring to Phase 4 or implementing only the cookie-specific case (which
has higher confidence).

### Tests needed

1. Unit test: action sets header, redirect drops it — warns.
2. Unit test: action sets cookie, redirect preserves it — no warning.
3. Unit test: action sets header, render phase includes it — no warning.

---

## Implementation Priority

| #   | Guardrail                                 | Confidence | Complexity | Priority      |
| --- | ----------------------------------------- | ---------- | ---------- | ------------- |
| W1  | Middleware != action guard                | High       | Low        | **P0**        |
| W3  | PE Response dropped                       | High       | Low        | **P0**        |
| W5  | Redirect after ctx.set()                  | Medium     | Medium     | **P1**        |
| W2  | Upstream ctx.set contract docs/tests only | N/A        | Low        | **Docs/Test** |
| W4  | Cache vs revalidation conflict            | Medium     | High       | **P2**        |
| W6  | Action headers dropped                    | Low-Med    | High       | **P3**        |

Start with W1 and W3 — highest confidence, lowest complexity, directly
address the most common misunderstandings documented in execution-model.md.
