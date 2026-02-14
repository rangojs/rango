# Route Type Generation: Test Plan

## Background

Route type generation has two phases in dev mode:

1. **Static parsing** (configResolved) -- fast, runs at startup, parses source
   text with regex/AST to extract `path()` names and `include()` prefixes.
   Cannot see dynamically generated routes (e.g. `Array.from()`, loops,
   runtime data).

2. **Runtime discovery** (configureServer) -- slower, evaluates actual router
   code via the module runner, finds everything including dynamic routes,
   overwrites the generated file with the complete set.

On file change the HMR watcher re-runs static parsing and writes immediately
(no `preserveIfLarger` guard) so new/removed routes appear in the IDE fast.

### The `preserveIfLarger` problem

`writeCombinedRouteTypes()` accepts `{ preserveIfLarger: true }`. When set,
it compares the number of routes in the existing `.gen.ts` file against the
new set and skips the write if the existing file is larger.

This was added to protect the `build -> dev` workflow: a production build
generates a complete manifest (say 100 routes), then dev startup's static
parser sees only 19 -- without the guard it would clobber the build output.

**Known issues:**

- **Route deletion not reflected on startup.** If a route is removed between
  builds, `preserveIfLarger` keeps the stale route in the generated file
  until runtime discovery overwrites it. During that window, `reverse()` calls
  for the deleted route would typecheck but 404 at runtime.

- **Route rename produces phantom entry.** Renaming a route (changing the
  `name:` option) looks like a removal + addition. The old name survives in
  the file due to `preserveIfLarger`, so both old and new names coexist
  until runtime discovery runs.

- **Early return skips subsequent routers.** The `return` on line 1022 of
  `generate-route-types.ts` exits the entire function, not just the current
  loop iteration. In a multi-router setup, if router A triggers the preserve
  guard, router B is never processed.

## What we aim to test

### Unit tests (`generate-route-types.ts`)

These test the static parser and `writeCombinedRouteTypes()` in isolation,
without a running Vite server.

#### 1. `preserveIfLarger` -- basic guard behavior

- Given an existing `.gen.ts` with 10 routes, calling with
  `{ preserveIfLarger: true }` and a new set of 5 routes should NOT
  overwrite the file.
- Given an existing file with 5 routes and a new set of 10, the file
  SHOULD be overwritten even with the guard enabled.
- Given equal counts, the file SHOULD be overwritten (content may differ).

#### 2. `preserveIfLarger` -- route deletion

- Given an existing file with routes A, B, C and a new set with A, B only
  (C was deleted), the guard currently prevents the write. Verify this
  is the current behavior so we can decide whether to change it.

#### 3. `preserveIfLarger` -- route rename

- Given an existing file with route `"blog.post"` and a new set where it
  was renamed to `"blog.article"`, verify current behavior: the guard
  sees fewer routes (count unchanged, but names differ) and decide
  whether to write.

#### 4. Early return in multi-router loop

- Set up two router files. Make router A trigger the preserve guard
  (existing > new). Verify that router B's file is still generated.
  Currently this is broken -- the `return` exits the whole function.

#### 5. Static parser accuracy

- Verify `buildCombinedRouteMapWithSearch()` correctly extracts routes
  from a source file with `path()` and `include()` calls.
- Verify dynamic routes (e.g. `Array.from().map(...)`) are NOT extracted
  by the static parser (confirming the limitation).

### E2E tests (dev server)

These test the full two-phase flow with a running Vite dev server.

#### 6. Startup: static then runtime

- Start dev server. Read `.gen.ts` immediately after startup.
- Verify it contains statically visible routes.
- Wait for runtime discovery to complete.
- Verify it now contains ALL routes including dynamic ones.

#### 7. HMR: add a route

Already covered by `route-types-hmr.test.ts`. Keep as-is.

#### 8. HMR: remove a route

Already covered by `route-types-hmr.test.ts`. Keep as-is.

#### 9. HMR: rename a route

- Rename a route's `name:` option (e.g. `"post"` -> `"article"`).
- Verify the old name disappears and the new name appears in the
  generated file.

#### 10. Build then dev: preserveIfLarger startup guard

- Run a production build to generate the complete `.gen.ts`.
- Start dev server.
- Verify the file is NOT clobbered by static parsing on startup.
- Verify runtime discovery eventually writes the correct set.

#### 11. Build then dev: deleted route reflected after discovery

- Run a production build (generates file with route X).
- Delete route X from source.
- Start dev server.
- Verify that after runtime discovery completes, route X is gone from
  the generated file (even though `preserveIfLarger` kept it on startup).

### Edge cases

#### 12. Empty router (no named routes)

- A router with only unnamed `path()` calls should produce an empty
  or minimal `.gen.ts` (no route entries).

#### 13. `include()` with "/" prefix

- Already covered by `route-types.test.ts` (no double-slash test).
  Keep as-is.

#### 14. Concurrent file changes

- Rapid successive file saves should not corrupt the generated file.
  The watcher should debounce or serialize writes correctly.

## Files involved

| File | Role |
|------|------|
| `src/build/generate-route-types.ts` | Static parser, `writeCombinedRouteTypes()` |
| `src/vite/index.ts:974-980` | Startup call (with `preserveIfLarger`) |
| `src/vite/index.ts:1178-1204` | HMR watcher (without `preserveIfLarger`) |
| `e2e/route-types.test.ts` | Existing e2e: startup + build |
| `e2e/route-types-hmr.test.ts` | Existing e2e: add/remove/touch |
| `e2e/test-app/src/urls/blog.tsx` | Test app route module |
| `e2e/test-app/src/router.named-routes.gen.ts` | Generated output |
