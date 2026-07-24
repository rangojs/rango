# Client URL Groups and Instant Navigation

Status: Phase 1 is implemented. The broader client URL architecture described
here is not. This document is design background: it records what the initial POC
proved, what the shipped vertical slice does, and which ideas remain optional
future work.

For the public contract, use [Client URL Routes](../client-urls.md). The current
implementation is also summarized in
[the implementation plan](./client-urls-implementation-plan.md).

## Status Boundary

| Area                            | Status                                                      |
| ------------------------------- | ----------------------------------------------------------- |
| Default `"use client"` module   | Implemented                                                 |
| `clientUrls()`                  | Implemented from `@rangojs/router/client`                   |
| `path`, `layout`, `loader`      | Implemented with named client component values              |
| `loading`                       | Implemented for server rendering and hydrated local display |
| `include()` mounting            | BASELINE; `.routes(definition)` is root-include sugar       |
| Server projection               | Implemented for `name`, `search`, and `trailingSlash`       |
| Hard SSR and hydration          | Implemented                                                 |
| Local loading + outlet pending  | Implemented after hydration for a different matched route   |
| Canonical partial Flight        | Implemented and still authoritative                         |
| Global router middleware        | Implemented through the existing canonical server chain     |
| Route-local middleware          | Unsupported; future design only                             |
| Client loader revalidation      | Unsupported; future design only                             |
| Loader-produced segment handles | Unsupported; optional future experiment                     |
| Prefix/include mounting         | BASELINE: `include()` in the canonical urls() tree          |
| Parallel/intercept routes       | Unsupported; future design only                             |
| Cache, transition, boundaries   | Unsupported                                                 |
| PPR                             | Unsupported                                                 |
| Dedicated route-data transport  | Not implemented; future optimization idea                   |

Composition is not a later phase — it is the baseline mounting model.
`clientUrls()` participates through `include()`: the include supplies URL and
route-name prefixes, wrapping layouts stay ordinary RSC layouts, and nested
middleware, loaders, boundaries, and route ownership derive from the canonical
server tree. Direct `.routes(clientUrlPatterns)` is a pure-client shorthand
that NORMALIZES to a root include (`include("/", definition, { name: "" })`) —
sugar over the same composition path, not a second registration model. Overlap
ownership therefore follows ordinary include/tree semantics. With this foundation in place, the next API exploration
is suspending `useLoader()` inside client route components.

## The Implemented Idea

A client URL definition gives the hydrated browser enough route topology to
present destination loading immediately. It does not make the browser the routing
authority.

```tsx
"use client";

import { clientUrls, useLoader, useOutlet } from "@rangojs/router/client";
import { PostLoader } from "./post.loader.js";

function BlogLayout() {
  const { content, pending } = useOutlet();
  return <main aria-busy={pending}>{content}</main>;
}

function BlogPost() {
  const { data } = useLoader(PostLoader);
  return <article>{data.title}</article>;
}

function BlogPostLoading() {
  return <p>Loading post...</p>;
}

export default clientUrls(({ path, layout, loader, loading }) => [
  layout(BlogLayout, () => [
    path("/blog/:postId", BlogPost, { name: "post" }, () => [
      loader(PostLoader),
      loading(<BlogPostLoading />),
    ]),
  ]),
]);
```

The definition mounts through `include()` in the canonical `urls()` tree,
alongside ordinary server patterns and under ordinary RSC layouts:

```tsx
export const urlpatterns = urls(({ include, layout }) => [
  layout(<CatalogRscLayout />, () => [
    include("/catalog", catalogClientUrls, { name: "catalog" }),
  ]),
]);

createRouter().use(globalMiddleware).routes(urlpatterns);
```

The server projection turns the client patterns into ordinary server paths. Hard
requests therefore use the canonical matcher, execute loaders, render HTML, and
hydrate the same client layout and path components.

On hydrated soft navigation, the local matcher handles presentation only:

```text
local pathname match
  -> transient destination loading or retained current branch
  -> useOutlet().pending for the rendered client layout branch

ordinary partial Flight request
  -> canonical server match
  -> global middleware
  -> projected loaders by id
  -> redirects/errors/Rango state
  -> URL, history, and content commit
```

The canonical response always wins. The client definition cannot authorize the
request, select middleware, execute or suppress a loader, commit history, or
override a server redirect or error.

## Why Both Markers Exist

`"use client"` and `clientUrls()` solve different problems:

| Marker         | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `"use client"` | Components belong to the client graph and may use client hooks |
| `clientUrls()` | The value is a client route descriptor with a local matcher    |

The module must default-export the descriptor. Path and layout components must be
named component values so validation and component diagnostics have stable names.

## Implemented Server Projection

Vite discovery cannot recover the descriptor by evaluating the client module in
the RSC environment because that import produces a React client reference. The
implemented path is:

1. Vite records a module with a directive-prologue `"use client"`, a
   `clientUrls()` call, and a default export.
2. Discovery evaluates that source with the SSR module runner.
3. `serializeClientUrlPatterns()` records patterns, names, supported path options,
   loader IDs, and whether loading UI exists.
4. The server registry associates that projection with the default client
   reference ID.
5. The router materializes ordinary `urls()` entries when the projection becomes
   available.

Only `name`, `search`, and `trailingSlash` survive `PathOptions` projection. `ppr`
and unknown options fail projection. The client route component and layout values
remain on the client-reference side rather than being serialized into the server
record.

Projected loaders are ordinary server loader work. The materialized definition
uses the loader's generated ID to recover its registered server implementation and
calls it with the canonical loader context. This works for the default
non-fetchable `createLoader()` form; Phase 1 does not turn route loaders into
browser loader RPCs.

## Implemented Loading and Pending Scope

When a local match selects a different client route record:

- a destination `loading()` value is rendered immediately;
- without destination loading, the current canonical route remains visible;
- the layouts around the branch being rendered receive
  `useOutlet().pending === true`;
- the presentation clears when the partial Flight navigation commits, redirects,
  errors, is cancelled, or is superseded.

The current scope is intentionally narrower than a general descendant-work
tracker. It is false during SSR and before the client registry mounts after
hydration. It does not report prefetch, generic Suspense, ordinary server-route
work, unrelated actions, or a params/search navigation that remains on the same
client route record.

`<Outlet />` remains the concise renderer. `useOutlet()` now returns:

```ts
interface OutletState {
  readonly content: ReactNode;
  readonly pending: boolean;
}
```

## Security Boundary

Local loading can render before global middleware has authenticated or authorized
the destination. The loading branch must not contain protected data or sensitive
route details. An application that cannot reveal the destination shell before
authorization should omit optimistic loading for that route.

The browser never receives middleware context and its route match is not evidence
of access. Global middleware remains server-executed and canonical.

## Historical POC Findings

The ignored POC remains at:

```text
packages/rangojs-router/e2e/mini/.vite-client-urls-poc
```

It preceded the implementation and isolated the UI question with a server
catch-all plus a small client runtime. It demonstrated that:

1. A client-known route can select a destination immediately.
2. A loading boundary can appear before server data arrives.
3. A Rango loader can return an RSC React tree as data.
4. Direct document loading works when the server owns the URL namespace.
5. A loader implementation can stay out of the client bundle while its generated
   ID crosses the boundary.

With an artificial 900 ms loader delay, the production POC observed loading at
32-35 ms and the server-created RSC tree at about 1.32 s. Development observed
about 63 ms and 1.35 s respectively. These local measurements justified the
vertical slice; they are not performance guarantees.

The POC also showed that an inline function-level `"use server"` directive inside
a `"use client"` module left the function body, JSX, and captured value in the
browser bundle. That shape remains unsupported.

## Future Design: Composition and Route Middleware

This section is not Phase 1 behavior.

A future static-prefix mount could make a client group one sub-application inside
a larger server tree. Before shipping, the server and browser projections would
need identical mount-param, route-name, trailing-slash, and type-generation
semantics. Dynamic or nested mounts would require their own proof.

Route-local middleware would have to remain server-owned. One possible API is an
imported top-level server reference:

```tsx
// Future design only; unsupported today.
export default clientUrls(({ path, middleware, loader }) => [
  path("/account", AccountPage, () => [
    middleware(requireAccount),
    loader(AccountLoader),
  ]),
]);
```

Any implementation would need to prove that the middleware body is absent from
browser output, that the browser cannot select or omit the canonical chain, and
that middleware-only references are not publicly callable actions. Until then,
only global `createRouter().use(...)` middleware applies.

## Future Design: Dedicated Route Data

This section is not Phase 1 behavior.

Phase 1 deliberately keeps canonical partial Flight. A future route-data request
could batch loader work or prefetch data separately from route code, but it would
need to preserve all behavior currently inherited from the navigation path:

- canonical matching and middleware;
- loader identity, dependency, cache, and error semantics;
- redirects, cookies, reload controls, and deployment versions;
- Rango-state cache keys, action fencing, and cross-tab invalidation;
- cancellation, supersession, Back/Forward, and history staleness.

The fetchable-loader endpoint is not a substitute for that protocol. A dedicated
transport either reaches parity and replaces the Phase 1 data lane or remains an
experiment; two silently different authoritative paths would be a correctness
bug.

## Future Design: Client Loader Revalidation

This section is not Phase 1 behavior. `revalidate()` is rejected by
`clientUrls()` today.

A later client predicate could decide which route loaders to reuse before a
route-data request. Such a predicate could only receive browser-known current and
next URL state, action identity/result, and staleness. It could not receive the
request, environment, cookies, headers, or middleware context.

The server would still have to verify that every requested loader belongs to the
canonical matched route. A client revalidation decision can be an optimization;
it cannot grant execution permission.

## Optional Future Experiment: Loader-Produced Segment Handles

Loader-produced segment handles are not a working design decision and are not
part of Phase 1. Existing projected loaders return their normal data through the
ordinary server segment path; Phase 1 adds no `{ data, handles }` resource shape,
loader-owned handle bucket, or client installation protocol.

An optional future experiment could investigate capturing handle pushes from a
segment-bound loader and committing data plus handle contributions atomically.
Before becoming a design decision it would need answers for:

- ownership when one loader definition is mounted under multiple segments;
- ordering across route loaders and parallel slots;
- failed, cancelled, or revalidated loader pushes;
- deferred handle values and settlement;
- prefetch and Back/Forward snapshot retention;
- compatibility with the current post-render handle read contract.

Fetchable loaders have no route-segment owner, so any future proposal would also
need to decide whether their pushes are discarded or exposed separately. No such
behavior ships today.

## Future Design: Parallel Routes and Intercepts

This section is not Phase 1 behavior. `parallel()` and `intercept()` are rejected
inside `clientUrls()`.

A future design would need stable slot ownership, independent loading and pending
scope, canonical hard-load behavior, history restoration, and a definition for
cross-boundary intercepts. A browser-known modal choice cannot bypass server
matching, middleware, or redirect authority.

## Future Design: Prefetch and History Resources

This section is not Phase 1 behavior. The shipped slice uses the existing partial
Flight prefetch/history machinery; it adds no client-route resource cache or
second history payload.

A dedicated future route-data lane could separate route-code preloading from
concrete-URL loader data. Those resources would need the same Rango-state,
mutation invalidation, deployment recovery, and bounded retention guarantees as
the current prefetch cache before they could be adopted on navigation.

## Future Design: Prerender and PPR

PPR is unsupported in `clientUrls()` and rejected during projection. Any future
integration remains a cache design, not a static-file shortcut: the worker would
still serve the request after middleware and the browser would still receive the
canonical result. The stored artifact and client-manifest relationship remain
open questions.

## Non-goals

- Making all Rango routes client routes by default.
- Running server middleware in the browser.
- Treating a browser match or server-reference ID as authorization.
- Shipping the complete canonical server manifest to the browser.
- Replacing loaders with a second user-facing query abstraction.
- Claiming unsupported future helpers through generated fallback behavior.

## Open Questions for Later Phases

- What static prefix composition syntax preserves one source route graph?
- What overlap policy can be enforced consistently without excluding legitimate
  response/MIME routes?
- Can a route-data transport reach full partial-Flight parity without duplicating
  navigation state?
- Which invalidation signals override a future client loader-retention decision?
- Is loader-produced handle capture useful enough to justify a second ownership
  lifetime?
- How would parallel outlet pending avoid marking sibling slots?
- What PPR artifact, if any, composes safely with a client-owned loading branch?

These questions do not expand the Phase 1 public surface.
