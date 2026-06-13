# Testing primitives review — 2026-06-13 (PR #533)

> Internal review record. Multi-agent review of the `@rangojs/router/testing`
> surface: 9 section deep-reviews (correctness/tests/docs/simplify) + 5 cross-cutting
> sweeps (API overview, test-suite coverage, docs/skills accuracy, production-safety of
> the test-runner gates, whole-module simplify). Every high/medium finding was
> adversarially verified by an independent agent before inclusion. See
> [testing-api-overview.md](./testing-api-overview.md) for the surface map.

## Totals

- **96** findings raised · **60** high/medium adversarially verified
- **44** confirmed real (26 fixed, 12 documented-only, 6 confirmed-correct/no-change)
- **16** rejected (false positives) · **36** low/nit (triaged below)

All confirmed `fix` findings were applied and the full gate is green (typecheck 12/12,
`test:unit:all`, lint, format). Plus external-feedback item **T8** (relax
`createTestRequestContext` ctx.reverse typing) — fixed + tested.

## Fixed (applied)

- **[high/correctness]** runMiddleware does not return stateCookieName despite accepting and resolving the stateCookie option — `src/testing/run-middleware.ts:213`
- **[high/docs]** Missing `ignoreCookies` option from expectParity options table — `skills/testing/e2e-parity.md:39-45`
- **[high/test]** E2E test suite lacks expectParity assertions for progressive-enhancement parity — `packages/rangojs-router/e2e/*.test.ts (112 files)`
- **[medium/api]** Inconsistent return envelope field naming: runLoader vs runLoaderResult — `src/testing/run-loader.ts:387-427`
- **[medium/correctness]** Missing error handling in snapshot() causes unhandled promise rejection if a testId doesn't exist — `src/testing/e2e/parity.ts:226`
- **[medium/docs]** Misleading caveat about ctx.theme/ctx.setTheme availability in loaders — `skills/testing/loader.md:121`
- **[medium/docs]** Misleading statement about dependency execution in loaders vs use resolver — `skills/testing/loader.md:116`
- **[medium/docs]** RunMiddlewareResult documentation does not list stateCookieName field — `skills/testing/middleware.md:43-50`
- **[medium/docs]** stateCookie option documentation says 'Assert via result.response / result.cookies' but should mention stateCookieName once available — `skills/testing/middleware.md:24`
- **[medium/docs]** Incomplete caveats documentation for \_rsc_action handling — `skills/testing/response-routes.md:81-89`
- **[medium/docs]** Unclear whether handles persist across navigate(), given global accumulation claim — `skills/testing/handles.md:29`
- **[medium/docs]** Outdated import directive for Playwright e2e — `skills/testing/cache-prerender.md:2`
- **[medium/docs]** expectParity return description omits options signature — `skills/testing/e2e-parity.md:53`
- **[medium/docs]** Decision table omits `runLoaderResult` row (side-effect-testing for loaders) — `skills/testing/SKILL.md:89`
- **[medium/docs]** Table uses stale phrasing: 'envelope sibling of runLoader' without explicit primitive name — `docs/testing.md:54`
- **[medium/simplify]** Duplicate headersToObject() implementations — `src/testing/internal/context.ts:244-251, src/testing/render-handler.ts:154-160`
- **[medium/test]** Missing test coverage for invalidateClientCache/keepClientCache behavior in runMiddleware — `src/testing/__tests__/run-middleware.test.ts`
- **[medium/test]** No test verifies that stateCookie seed customization produces the correct resolved name — `src/testing/__tests__/run-middleware.test.ts`
- **[medium/test]** Missing test coverage for \_rsc_action redirect interception — `src/testing/__tests__/dispatch.test.ts:807-829`
- **[medium/test]** No test coverage for handles across router.navigate() — `src/testing/__tests__/render-route.test.tsx:328-362`
- **[medium/test]** Test examples use URL patterns instead of route names as cache header keys — `src/testing/__tests__/cache-status.test.ts:20-88`
- **[medium/test]** Test verifies the preset returns the right count but doesn't verify the actual node condition resolution — `src/__tests__/installed-vitest-config.test.ts:76-78`
- **[medium/test]** settleSubmit() unstable state timeout falls through silently without warning — `src/testing/e2e/parity.ts:185-218`
- **[medium/test]** Telemetry type re-exports are tested but telemetry-sink-based assertion workflow is minimally exercised — `packages/rangojs-router/src/testing/__tests__ (all test files)`
- **[medium/test]** renderRoute does not test the mount option with dynamic mount prefixes (e.g., `include('/:locale?', ...)`) — `packages/rangojs-router/src/testing/__tests__/render-route.test.tsx`
- **[medium/test]** searchData option is tested, but typed search schema validation across the test harness is not exercised — `packages/rangojs-router/src/testing/__tests__/render-route.test.tsx, run-loader.test.ts`

Plus **T8** [medium/api] — `createTestRequestContext().ctx.reverse` now typed via
`TestRequestContextObject` (accepts any local-`routeMap` name, mirroring `TestLoaderContext`).

## Documented-only (confirmed, deliberately not coded)

- **[medium/docs]** Prose docs truncated at line 957; cannot verify if all recent additions (buildRunSnapshot, telemetry re-exports, renderHandler details) are covered — `docs/testing.md:957`
- **[low/correctness]** Document production safety of allowServerInTest gate — `src/component-utils.ts:80`
- **[low/correctness]** collectHandleData has bare process.env.NODE_ENV access in browser-exported function — `/Users/ivotodorov/Development/vite-rsc/packages/rangojs-router/src/handle.ts:170`
- **[low/docs]** Caveat explicitly states `test.alias` + `test.server.deps.inline` placement, but this is misleading to consumers — `skills/testing/setup.md:113`
- **[low/docs]** Missing documentation: testPattern does not validate patterns — `src/host/testing.ts`
- **[low/docs]** Telemetry type re-exports not documented in SKILL.md intro — `skills/testing/SKILL.md:34`
- **[low/docs]** No dedicated testing skill for host-router (`@rangojs/router/host/testing`) — `skills/testing/SKILL.md`
- **[low/docs]** Decision table row 97 mentions 'telemetry sink' as example but does not explain the primitives — `skills/testing/SKILL.md:97`
- **[low/simplify]** Duplicate response-building logic (buildRunResponse vs buildResponse) — `src/testing/internal/context.ts:261-278, src/testing/render-handler.ts:187-204`
- **[low/test]** Missing test coverage for deep-equal edge case with nested complex types — `src/testing/__tests__/flight-tree.rsc-test.tsx:line 252-268`
- **[low/test]** No explicit tests for vitest.ts presets and flight-matchers configuration — `src/testing/__tests__,src/testing/vitest.ts`
- **[low/test]** runLoaderResult and runInRequestContext effects are tested, but the effect-snapshot envelope (buildRunSnapshot) is not unit-tested directly — `packages/rangojs-router/src/testing/__tests__/run-loader.test.ts, run-in-request-context.test.ts`

Notable decisions:

- **`headersToObject` duplication** (render-handler vs internal/context): NOT shared —
  `internal/context.ts` is the node tier and is deliberately NOT react-server-safe
  (the reason `seed-vars.ts` was split out); `render-handler` ships from the
  react-server `./testing/flight` entry. A 6-line pure projection is cheaper to
  duplicate than to route a shared util across that boundary (in-code comment added).
- **Typed-search SCHEMA validation**: the harness seeds `searchData` verbatim — it does
  not run a typed-search schema, so schema parsing/validation is e2e (documented in the
  loader skill's search caveat).

## Confirmed-correct (verified, no change needed)

The production-safety sweep confirmed every test-runner gate is correct — a real
dev/build still throws; relaxations fire only under `isUnderTestRunner()` (`process.env.VITEST`):

- `/Users/ivotodorov/Development/vite-rsc/packages/rangojs-router/src/prerender.ts:392` — Prerender has correct test-runner gate with runtime fallback
- `/Users/ivotodorov/Development/vite-rsc/packages/rangojs-router/src/runtime-env.ts:17` — isUnderTestRunner() correctly uses optional chaining for process.env access
- `/Users/ivotodorov/Development/vite-rsc/packages/rangojs-router/src/handle.ts:114` — createHandle has correct test-runner gate with safe error path
- `/Users/ivotodorov/Development/vite-rsc/packages/rangojs-router/src/loader.ts:57` — createLoader (client stub) has correct test-runner gate
- `/Users/ivotodorov/Development/vite-rsc/packages/rangojs-router/src/static-handler.ts:110` — Static has correct test-runner gate with runtime fallback
- `/Users/ivotodorov/Development/vite-rsc/packages/rangojs-router/src/component-utils.ts:80` — assertClientComponent correctly gates allowServerInTest relaxation on isUnderTestRunner()

## Deferred follow-up

- **[high/test] Progressive-enhancement parity across the legacy e2e suite.** `expectParity`
  is demonstrated dev+prod in `e2e/consumer-testing-harness.test.ts`, but ~36 pre-existing
  e2e files that exercise form/action/navigation flows do not yet use it. Retrofitting the
  whole legacy suite is a separate initiative (each file needs dev+prod runs), out of scope
  for this PR's surface — tracked as a follow-up, not blocking.

## Rejected (false positives)

- **[simplify]** buildRunSnapshot duplicates response/headers building logic already present in buildRunResponse/headersToObject — `src/testing/internal/context.ts:288-304`
- **[correctness]** Handle data not re-attached during navigation, silently loses seeded values — `src/testing/render-route.tsx:526-539`
- **[correctness]** deepEqual Map comparison does not validate that both Maps have identical key sets — `src/testing/flight-tree.ts:line 154-159`
- **[docs]** Documentation describes x-rango-keep-cache header but does not mention the actual header key name — `skills/testing/render-handler.md:line 51`
- **[correctness]** Type cast of AST from vite's parseAstAsync to @vitejs/plugin-rsc's expected type is unsafe — `src/testing/vitest.ts:279`
- **[docs]** RangoE2E interface signature differs from exported PageHelpers — `src/testing/e2e/index.ts:86-103`
- **[api]** renderHandler and runInRequestContext return shapes are asymmetric — `src/testing/render-handler.ts:99-127`
- **[api]** Missing explicit 'request' unification and incomplete options forwarding — `src/testing/run-middleware.ts,src/testing/dispatch.ts`
- **[api]** renderRoute seeding model is underdocumented (loaderData vs loaders precedence) — `src/testing/dom.entry.ts,src/testing/render-route.tsx`
- **[test]** E2E test suite does NOT use parityDescribe; 111/112 tests use manual dev/(production) titling — `packages/rangojs-router/e2e/*.test.ts (112 files)`
- **[docs]** Feature-map exports listing omits buildRunSnapshot and misses new Flight + Flight-Tree operations — `docs/internal/feature-map.md:40`
- **[docs]** Sub-files list is incomplete: missing setup.md reference and misses render-handler.md section heading — `skills/testing/SKILL.md:104-116`
- **[correctness]** createLoader (RSC/server) has correct test-runner gate with runtime fallback — `/Users/ivotodorov/Development/vite-rsc/packages/rangojs-router/src/loader.rsc.ts:69`
- **[correctness]** segment-structure-assert has bare process.env.NODE_ENV (dev-only warning, folded) — `/Users/ivotodorov/Development/vite-rsc/packages/rangojs-router/src/browser/segment-structure-assert.ts:44`
- **[simplify]** Duplicate toRequest() implementations across files — `src/testing/internal/context.ts:36-46, src/testing/render-handler.ts:162-171, src/testing/dispatch.ts:149-152, src/testing/run-loader.ts:184-202`
- **[simplify]** Similar context option mapping patterns (buildLoaderCtxOpts vs inline ctxOpts) — `src/testing/run-loader.ts:257-277, src/testing/run-middleware.ts:149-161`

## Low / nit (triaged)

36 low/nit findings were collected and passed through without per-item
adversarial verification. Representative items:

By category: api (3), correctness (5), docs (7), simplify (13), test (8).

- **[nit/api]** Type cast hides parameter signature mismatch for error function — `src/testing/run-loader.ts:302-310`
- **[low/simplify]** Duplicate \_rsc param stripping logic instead of using stripInternalParams utility — `src/testing/dispatch.ts:406-409`
- **[low/correctness]** Cache store resolution passes undefined as executionContext to cache option function — `src/testing/dispatch.ts:340-346`
- **[low/docs]** Missing renderRoute from the testing surface table — `docs/testing.md:54`
- **[low/simplify]** matchLeaf() decodes params that may already be decoded by the URL constructor — `src/testing/render-route.tsx:289-304`
- **[low/test]** Error rejection test depends on implicit 2s timeout, not an explicit assertion — `src/testing/__tests__/flight.rsc-test.tsx:line 92-101`
- **[low/docs]** Documentation mentions toMatchFlightSnapshot runs only under react-server project, but uses singular 'vitest project' — `skills/testing/flight.md:line 43`
- **[low/test]** Test for 'unknown name yields empty array' is somewhat redundant — `src/testing/__tests__/flight-tree.rsc-test.tsx:line 100-107`
- **[nit/simplify]** Double negative in module-level comment makes it harder to parse — `src/testing/flight-tree.ts:line 288-298`
- **[nit/simplify]** resolveServerLazy loop has an implicit assumption about the 1000 iteration limit — `src/testing/flight-tree.ts:line 396-411`
- **[low/correctness]** Potential false negative if header key is an empty string — `src/testing/cache-status.ts:98`
- **[nit/simplify]** createCacheSink could be a factory with a builder pattern — `src/testing/cache-status.ts:147-155`
- **[low/test]** Fallback warn test does not verify the console.warn message content — `src/testing/__tests__/collect-handle.test.ts:68-76`
- **[low/docs]** Documentation comment on segments parameter is slightly ambiguous — `src/testing/collect-handle.ts:25-29`
- …and 22 more (see the workflow run record).
