# Client URL Groups and Instant Navigation

Status: the `clientUrls()` slice is shipped and converging — browser matching,
canonical partial-Flight navigation, client-run per-loader `revalidate()`,
restricted `intercept()`, data-only `transition()`, loader authority signals
and handle writes, implicitly-suspending `useLoader`, and
`loader(Def, { stream: "navigation" })`. This document is design background:
it records what the initial POC proved, what the shipped slice does, and which
ideas remain optional future work. Sections below marked "since shipped" are
kept as the historical design record; the current contract is
[Client URL Routes](../client-urls.md).

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
| Client loader revalidation      | Implemented: browser-run per-loader `revalidate()` predicates, decision header |
| Loader handle writes / signals  | Implemented via the general loader contract: `ctx.use(Handle)` pushes, thrown `notFound()`/`redirect()`; no `{ data, handles }` resource shape |
| Loader delivery options         | Implemented: `loader(Def, { stream: "navigation" })` document-render await |
| Prefix/include mounting         | BASELINE: `include()` in the canonical urls() tree          |
| Intercept routes                | Implemented, restricted: dot-local named target, loader/loading use only |
| Parallel routes                 | Unsupported; future design only                             |
| Transition                      | Implemented, data-only (no `when`)                          |
| Cache, boundaries               | Unsupported (boundaries deliberately — server tree owns them) |
| PPR                             | Unsupported                                                 |
| Dedicated route-data transport  | Not implemented; future optimization idea                   |

Composition is not a later phase — it is the baseline mounting model.
`clientUrls()` participates through `include()`: the include supplies URL and
route-name prefixes, wrapping layouts stay ordinary RSC layouts, and nested
middleware, loaders, boundaries, and route ownership derive from the canonical
server tree. Direct `.routes(clientUrlPatterns)` is a pure-client shorthand
that NORMALIZES to a root include (`include("/", definition, { name: "" })`) —
sugar over the same composition path, not a second registration model. Overlap
ownership therefore follows ordinary include/tree semantics. `useLoader()`
inside client route components suspends implicitly (streaming loaders) —
shipped, no longer an exploration.

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
non-fetchable `createLoader()` form; the shipped slice does not turn route
loaders into browser loader RPCs.

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

## Future Design: Route Middleware

This section is not shipped behavior. (The composition half of the original
question is settled: `include()` mounting with URL/name prefixes IS the
baseline model, above.)

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

This section is not shipped behavior.

The shipped slice deliberately keeps canonical partial Flight. A future route-data request
could batch loader work or prefetch data separately from route code, but it would
need to preserve all behavior currently inherited from the navigation path:

- canonical matching and middleware;
- loader identity, dependency, cache, and error semantics;
- redirects, cookies, reload controls, and deployment versions;
- Rango-state cache keys, action fencing, and cross-tab invalidation;
- cancellation, supersession, Back/Forward, and history staleness.

The fetchable-loader endpoint is not a substitute for that protocol. A dedicated
transport either reaches parity and replaces the shipped data lane or remains an
experiment; two silently different authoritative paths would be a correctness
bug.

## Since Shipped: Client Loader Revalidation

This design has since shipped: per-loader `revalidate()` predicates are
declared in the client module, execute in the browser with client-computable
args, and only their DECISION crosses on the request header — exactly the
boundary this section demanded (no request/env/cookies/middleware context in
the predicate, server-side decisions only address the group's own loader
stubs, defaults for decision-less requests). See
[Client URL Routes](../client-urls.md) for the contract.

## Since Shipped (differently): Loader Handle Writes

The original proposal here — a `{ data, handles }` resource shape with a
loader-owned handle bucket and a client installation protocol — did NOT ship
and remains rejected. What shipped instead is simpler: loader bodies gained
the GENERAL handle contract (`ctx.use(Handle)` pushes with handler parity,
delivery by the barrier race model, `ctx.get(handle)` reads behind
`await ctx.rendered()`), so a projected client-urls loader pushes meta and
breadcrumbs like any DSL loader, and
`loader(Def, { stream: "navigation" })` makes document delivery
deterministic. The open questions below were resolved by that framing —
pushes attribute to the loader's owning segment, and no second ownership
lifetime exists. Fetchable loaders invoked outside a route render still have
no segment owner and their pushes are not exposed.

## Future Design: Parallel Routes

This section is not shipped behavior: `parallel()` is rejected inside
`clientUrls()`. (`intercept()` HAS since shipped in a restricted,
JSON-projectable form — dot-local named target, `loader()`/`loading()` use,
module-local scoping via a synthesized origin-`when`; see
[Client URL Routes](../client-urls.md).)

A future parallel design would need stable slot ownership, independent
loading and pending scope, canonical hard-load behavior, and history
restoration. A browser-known slot choice cannot bypass server matching,
middleware, or redirect authority.

## Future Design: Prefetch and History Resources

This section is not shipped behavior. The shipped slice uses the existing partial
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

- Growing the group DSL toward server-tree parity. `clientUrls()` is
  deliberately minimal — a performance surface (instant presentation, held
  data, streaming reads), not full-feature routing. Full-feature concerns
  (middleware, parallels, caching, boundaries, PPR) stay in the server tree
  around the mount; the "future design" sections above record what a change
  of heart would have to prove, not an intent.
- Making all Rango routes client routes by default.
- Running server middleware in the browser.
- Treating a browser match or server-reference ID as authorization.
- Shipping the complete canonical server manifest to the browser.
- Replacing loaders with a second user-facing query abstraction.
- Claiming unsupported future helpers through generated fallback behavior.

## Open Questions

- What overlap policy can be enforced consistently without excluding legitimate
  response/MIME routes?
- Can a route-data transport reach full partial-Flight parity without duplicating
  navigation state?
- How would parallel outlet pending avoid marking sibling slots?
- What PPR artifact, if any, composes safely with a client-owned loading branch?

(Resolved since first drafted: static-prefix composition is the shipped
`include()` model; client loader retention is the shipped browser-run
`revalidate()`; loader handle capture shipped as the general loader handle
contract with segment-attributed pushes, no second ownership lifetime.)

These questions do not expand the shipped public surface.
