# Client URLs Implementation Plan

Status: Phase 1 is implemented. This document records the shipped vertical slice
and keeps later phases separate from it. The broader destination architecture in
[client URL groups and instant navigation](./client-urls-instant-navigation.md)
remains design background, not a description of the current API.

The consumer contract is documented in [Client URL Routes](../client-urls.md).
When this plan and the guide differ, the guide and current source are the shipped
contract.

## Release Gate Status

The initial public gate passed for the narrow Phase 1 slice:

| Seat                   | Checked evidence                                                               |
| ---------------------- | ------------------------------------------------------------------------------ |
| Node development       | `e2e/client-urls.test.ts` hard SSR/hydration and hydrated soft navigation      |
| Node production        | The same suite under its `(production)` build fixture                          |
| Cloudflare development | `tests/cloudflare-basic/e2e/client-urls.test.ts` hard load and soft navigation |
| Cloudflare production  | The same Cloudflare suite under its `(production)` build fixture               |

Both app suites assert hard-load server output, hydration without page errors,
loader data and params, immediate destination loading, `useOutlet().pending`,
canonical URL commit, and Back restoration. The source tests separately pin
projection serialization, server matching, loader execution by ID, route typing,
and the public `renderRoute({ outletPending })` seam.

This evidence does not mark the original broader design complete. In particular,
it does not ship prefixed composition, route-local middleware, client-side loader
revalidation, loader-owned handles, a dedicated route-data transport, parallel
routes, intercepts, boundaries, caching, transitions, or PPR.

## Implemented Phase 1 Contract

```tsx
// app.client-urls.tsx
"use client";

import { clientUrls, useLoader, useOutlet } from "@rangojs/router/client";
import { PostLoader } from "./post.loader.js";

function AppLayout() {
  const { content, pending } = useOutlet();
  return <main aria-busy={pending}>{content}</main>;
}

function PostPage() {
  const { data } = useLoader(PostLoader);
  return <article>{data.title}</article>;
}

function PostLoading() {
  return <p>Loading post...</p>;
}

export default clientUrls(({ layout, path, loader, loading }) => [
  layout(AppLayout, () => [
    path("/posts/:id", PostPage, { name: "post" }, () => [
      loader(PostLoader),
      loading(<PostLoading />),
    ]),
  ]),
]);
```

```tsx
// router.tsx
import { createRouter } from "@rangojs/router";
import clientUrlPatterns from "./app.client-urls.js";
import { serverUrls } from "./server-urls.js";

export const router = createRouter()
  .use(globalMiddleware)
  .routes(serverUrls)
  .routes(clientUrlPatterns);
```

The direct `.routes(clientUrlPatterns)` form is the only client URL mount. A
router accepts one distinct client definition. `include()` and prefix mounting
are not Phase 1 features.

### Supported Surface

| Capability                   | Phase 1 behavior                                                               |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Module shape                 | `"use client"` module with a default-exported `clientUrls()` value             |
| `path()` and `layout()`      | Named client component values                                                  |
| `loader()`                   | Imported server `createLoader()` definition, executed by registered ID         |
| Non-fetchable loaders        | Supported; the projected route invokes the server definition directly          |
| `loading()`                  | Client-owned value available for hydrated optimistic presentation              |
| Path options                 | `name`, `search`, and `trailingSlash` only                                     |
| Router registration          | Direct root `.routes(clientUrlPatterns)`; one client definition per router     |
| Global middleware            | Existing `.use(...)` chain, derived and run by the canonical server route      |
| Hard request                 | Projected server match, loaders, SSR, and hydration                            |
| Hydrated different-route nav | Local loading/pending, then canonical partial Flight commit                    |
| History and Back/Forward     | Existing navigation bridge and canonical history representation                |
| Type generation              | Global and per-module maps recognize statically legible `clientUrls()` routes  |
| `useOutlet()`                | Returns `{ content, pending }`; pending is the narrow local-presentation scope |

Named means the component value has a non-empty function name. Phase 1 does not
require consumers to export every path or layout component.

The unsupported list is explicit: `middleware()`, `revalidate()`, `include()`,
`parallel()`, `intercept()`, `cache()`, `transition()`, error/not-found
boundaries, and PPR. Other path options are rejected by server projection. The
implementation does not currently make a documented overlap-rejection promise.

## Implemented Navigation Flow

A hydrated navigation to a different matching client route uses one existing
navigation transaction:

1. The current navigation bridge receives the click or imperative navigation.
2. The mounted client definition matches the target pathname locally.
3. The client root marks its rendered outlet branch pending. If the destination
   has `loading()`, that value renders; otherwise the current branch remains.
4. In parallel, the normal navigation client requests the canonical partial
   Flight response.
5. The server matches the materialized route, runs global middleware and projected
   loaders, and renders the ordinary segment result.
6. Existing partial-update code handles redirects, errors, Rango state, history,
   and content commit.
7. The local presentation clears on commit, failure, redirect, cancellation, or
   supersession.

The local match is presentation intent, not request truth. It cannot authorize a
route, choose middleware, execute or suppress a loader, commit history, or
override the server result.

`useOutlet().pending` is correspondingly narrow. It is false during SSR and
before the client registry mounts after hydration. It is true for the rendered
client layout branch while a local match to a different client route waits for
canonical settlement. It does not describe prefetch, generic Suspense, ordinary
server routes, unrelated actions, or a params/search change that keeps the same
client route record.

The optimistic loading branch may appear before global auth middleware finishes.
It must not contain protected data or reveal route state that itself requires
authorization.

## Implemented Projection Facts

One client definition feeds both seats:

- `client-urls/client-urls.ts` builds the browser descriptor and its scoped trie.
- Vite records only a default-exported `clientUrls()` call in a directive-prologue
  `"use client"` module, then evaluates that module through the SSR runner.
- `client-urls/server-projection.ts` serializes route pattern, name, supported
  options, loader IDs, and loading presence without serializing component bodies.
- The router materializes ordinary `urls()` paths from that projection.
- Projected loader stubs resolve the original definition through
  `getLoaderLazy(id)` and call it with the canonical server loader context.
- `router.ts` permits ordinary server patterns and one client definition in the
  same builder chain.
- `browser/navigation-bridge.ts` asks the mounted client definition for transient
  presentation before it starts the existing partial Flight fetch; the same
  bridge still owns cancellation, history, and commit.
- Static route-type extraction recognizes `clientUrls()` variable and default
  export forms, including direct router registration.

These facts do not introduce a route-data request, a second loader cache, a
second history payload, browser middleware execution, or browser authority over
canonical matching.

## Implemented File Ownership

| Area                    | Owners                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Descriptor and types    | `src/client-urls/client-urls.ts`, `src/client-urls/types.ts`                                                     |
| Server projection       | `src/client-urls/server-projection.ts`, `src/router.ts`, `src/router/router-interfaces.ts`                       |
| Client presentation     | `src/client-urls/client-root.tsx`, `src/client-urls/navigation.ts`, `src/browser/navigation-bridge.ts`           |
| Outlet state            | `src/outlet-context.ts`, `src/outlet-provider.tsx`, `src/segment-system.tsx`, `src/client.tsx`                   |
| Vite discovery          | `src/vite/discovery/client-urls-projection.ts`, `src/vite/router-discovery.ts`, discovery state/bootstrap owners |
| Route type generation   | `src/build/route-types/`, `src/vite/discovery/route-types-writer.ts`                                             |
| Public DOM testing      | `src/testing/render-route.tsx`, `src/testing/dom.entry.ts`                                                       |
| Internal tests          | `src/client-urls/__tests__/`, `src/vite/discovery/__tests__/client-urls-projection.test.ts`                      |
| Node e2e                | `packages/rangojs-router/e2e/client-urls.test.ts`                                                                |
| Cloudflare consumer e2e | `tests/cloudflare-basic/e2e/client-urls.test.ts`                                                                 |

The exhaustive ownership list lives in
[feature-file-map.md](../internal/feature-file-map.md).

## Deferred Phase 2: Composition

Phase 2 is not implemented. It may investigate:

1. Route-local middleware imported from a top-level `"use server"` module.
2. A client URL group mounted beneath a static prefix.

Either feature must preserve canonical server middleware derivation and
Node/Cloudflare dev/production parity. Inline function-level `"use server"`
middleware inside the client module is not a supported fallback. Dynamic/nested
mounts and overlap policy need a separate, source-backed contract before they can
be documented as behavior.

## Deferred Phase 3: Route-Data Transport

Phase 3 is not implemented. A future dedicated route-data transport could batch
selected loader work and prefetch route data independently from route code, but it
would replace security- and correctness-sensitive behavior currently inherited
from partial Flight. Before replacing that path it must prove parity for canonical
matching, middleware, loader ownership, redirects, cookies, errors, Rango state,
action fencing, history, cancellation, Back/Forward, and deployment recovery.

Until then, the ordinary partial Flight path is the implementation and reference
contract.

## Other Deferred Work

The following are not part of Phase 1 or implied by its release:

- client-side loader `revalidate()` predicates;
- loader-produced segment handles;
- a suspending `useLoader()` contract;
- parallel routes and intercepts inside `clientUrls()`;
- cache and transition helpers;
- error and not-found boundaries;
- PPR or prerender integration;
- nested/dynamic group mounts and a documented overlap policy.

Loader-produced handles are, at most, an optional future experiment. They are not
a working design decision and no `{ data, handles }` resource shape ships in
Phase 1.

## Verification Commands

Focused checks for the implemented slice:

```bash
pnpm --filter @rangojs/router exec playwright test client-urls.test.ts --project=dev --no-deps
pnpm --filter @rangojs/router exec playwright test client-urls.test.ts --project=production --no-deps

pnpm --filter cloudflare-basic exec playwright test e2e/client-urls.test.ts --project=dev --no-deps
pnpm --filter cloudflare-basic exec playwright test e2e/client-urls.test.ts --project=production --no-deps
```

The repository-wide pre-push gate and documentation checks remain:

```bash
pnpm run typecheck
pnpm run test:unit:all
pnpm run lint
pnpm run format
pnpm check:doc-links
pnpm check:docs-api
```
