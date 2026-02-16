# Client/Isomorphic Loader Review

Date: 2026-02-16  
Scope: client loader + isomorphic loader implementation in `@rangojs/router`

## Findings

1. High: export-only `createIsomorphicLoader` modules are stubbed in client builds, dropping client function registration.  
File: `packages/rangojs-router/src/vite/expose-internal-ids.ts:1200`  
File: `packages/rangojs-router/src/vite/expose-internal-ids.ts:458`  
Risk: for export-only modules, the transformed client code becomes `{ __brand, $$id }` and never runs `registerClientLoader(...)`, so browser-side resolution cannot execute the isomorphic client loader function.

2. High: intercept loader resolution still executes all loaders via `context.use(...)` on the server.  
File: `packages/rangojs-router/src/router/intercept-resolution.ts:206`  
File: `packages/rangojs-router/src/router/intercept-resolution.ts:372`  
File: `packages/rangojs-router/src/server/context.ts:79`  
Risk: `LoaderEntry` now accepts `AnyLoaderDefinition`, including client/isomorphic loaders. If a client loader is used in an intercept entry, server execution path can fail because no server loader function exists.

3. Medium: `useLoader`/`useFetchLoader` accept `AnyLoaderDefinition`, but `load/refetch` always call the server `_rsc_loader` fetch path.  
File: `packages/rangojs-router/src/use-loader.tsx:147`  
File: `packages/rangojs-router/src/use-loader.tsx:202`  
File: `packages/rangojs-router/src/use-loader.tsx:355`  
File: `packages/rangojs-router/src/use-loader.tsx:435`  
Risk: API surface implies client loaders are supported for manual refetch, but runtime implementation is server-loader only.

4. Medium: global SSR abort timeout is hardcoded to `200ms`, which can cut off slower Suspense boundaries and produces noisy abort logs.  
File: `packages/rangojs-router/src/ssr/index.tsx:290`  
Risk: legitimate slow boundaries may be aborted too aggressively, and `AbortError` appears in server logs during normal operation.

## Open Questions

1. Are client/isomorphic loaders intended to be supported inside `intercept(...)` trees?
2. Should `load/refetch` for client/isomorphic loaders run client functions, or be blocked at type/runtime level?

## Validation Executed

1. `pnpm -C packages/rangojs-router typecheck` passed.
2. `pnpm -C packages/rangojs-router test e2e/client-loader.test.ts` passed (8/8), with `AbortError` logs emitted from SSR abort behavior.
