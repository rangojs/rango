# API Boundary Policy

This is the contributor-facing policy for deciding where exports belong.

The goal is simple: every public subpath should expose coherent user concepts,
not implementation plumbing.

## Public Surface Rules

### `@rangojs/router`

Use the root entrypoint for:

- server/RSC router construction APIs
- route DSL helpers
- shared user-facing types and utilities

The root entrypoint is conditionally resolved through the `react-server`
export condition. Do not treat it as a generic client/runtime barrel.

### `@rangojs/router/client`

Use `./client` for:

- hooks
- client components
- client navigation and state helpers

If an API is primarily used from client components, it belongs here.

### `@rangojs/router/cache`

Use `./cache` for public cache concepts:

- cache stores
- document cache middleware
- cache scope helpers

Do not expose cache stores from `./rsc` or other advanced subpaths when
`./cache` is the canonical user-facing home.

### `@rangojs/router/host`

Use `./host` only for public host-routing concepts:

- host router creation
- host matching helpers
- host-router error types

Build-time discovery registries or other wiring helpers do not belong here.

### `@rangojs/router/theme`

Use `./theme` for public theming APIs:

- `useTheme`
- `ThemeProvider`
- `ThemeScript`
- public theme types and constants

Do not expose raw context objects or script-generation internals unless they
are intentionally part of the product surface.

### `@rangojs/router/vite`

Use `./vite` only for the public plugin surface:

- `rango()`
- plugin option types

Plugin internals, discovery helpers, and virtual-module plumbing stay internal.

### `@rangojs/router/rsc` and `@rangojs/router/ssr`

These are advanced server-only integration subpaths.

Use them for:

- custom request-pipeline APIs
- custom HTML rendering bridge APIs
- their public option and dependency types

Do not use them as overflow buckets for unrelated public utilities. Internal
request-context mutation helpers, handle-store plumbing, and duplicate cache
exports should stay out.

## Internal Surface Rules

### `@rangojs/router/server`

Use `./server` for build/runtime internals that must be imported by plugin or
runtime integration code but are not part of the public API contract.

Examples:

- router registries
- discovery bridges
- manifest wiring

### `@rangojs/router/__internal`

Use `./__internal` for implementation plumbing that has no user-facing story
and can change freely.

## Review Checklist

When adding or moving an export:

1. Is this a real user concept or only implementation plumbing?
2. Does it have one canonical public subpath already?
3. Would documenting this export make sense to end users?
4. If this changed, would it create an accidental semver obligation?

If the answer points to “implementation plumbing”, prefer `./server` or
`./__internal` over a public subpath.

## Guardrails

The API boundary is enforced by tests:

- `src/__tests__/documentation-imports.test.ts`
- `src/__tests__/public-consumer-imports.test.ts`
- `src/__tests__/installed-consumer-imports.test.ts`
- `src/__tests__/public-export-boundaries.test.ts`

If you change exports or import guidance, update the tests and the public docs
in the same PR.
