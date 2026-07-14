# Testing a client component — renderRoute

**Layer:** unit (DOM) · **Import:** `@rangojs/router/testing/dom` · **DSL it tests:** a client component reading router context (see `/hooks`)

RTL-style stub (peer of React Router's `createRoutesStub` / Expo's `renderRouter`). It mounts the router's REAL `NavigationProvider` plus a synthetic segment tree built from the `routes` you pass, so client hooks resolve against production context — no server, no Vite build, no Flight round-trip. Loader data, location state, and handle output are SEEDED into client context; nothing is executed.

## API

### Options — `RenderRouteOptions`

| Field             | Type                                                                   | Meaning                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`         | `Request \| string`                                                    | Initial location. Only the URL is read (client render — headers/method ignored). Defaults to the leaf spec's static prefix or `"/"`.                                                                                                          |
| `loaderData`      | `Record<string, unknown>`                                              | Loader data keyed by loader `$$id`. `useLoader(L)` reads `loaderData[L.$$id]`.                                                                                                                                                                |
| `loaders`         | `ReadonlyArray<readonly [LoaderDefinition<any>, unknown]>`             | Seed by REFERENCE: `[loader, data]` pairs. Robust for real `createLoader()` handles whose `$$id` is empty in a bare test. Prefer over `loaderData`.                                                                                           |
| `params`          | `Record<string, string>`                                               | Explicit params, merged over (and overriding) params extracted from the `request` URL.                                                                                                                                                        |
| `locationState`   | `ReadonlyArray<readonly [LocationStateDefinition<any, any>, unknown]>` | Seed `useLocationState(def)` by REFERENCE: `[def, value]` pairs; written to `history.state`.                                                                                                                                                  |
| `handles`         | `ReadonlyArray<readonly [Handle<any, any>, unknown[]]>`                | Seed `useHandle(handle)` by REFERENCE: `[handle, pushedValues[]]`. Accumulated GLOBALLY (not segment-scoped).                                                                                                                                 |
| `handle`          | `HandleDataSeed`                                                       | Advanced: raw wire format `{ [handleId]: { [segmentId]: pushedValues[] } }`. Prefer `handles`. Merged with it.                                                                                                                                |
| `routeMap`        | `Record<string, string>`                                               | Name -> pattern map (informational; client `useReverse` takes its map as an argument, so this is not consumed).                                                                                                                               |
| `basename`        | `string`                                                               | `createRouter({ basename })` value. Wired into `NavigationProvider` so `useRouter().basename`, `<Link>` prefixing, `useMount`/`useHref` resolve against the mount. Normalized like `createRouter`. Defaults to root.                          |
| `mount`           | `string`                                                               | `include()` mount prefix. Wraps the segment chain in a `MountContext` so `useMount()` returns the prefix. Normalized like a path prefix. Defaults to `"/"`.                                                                                   |
| `theme`           | `ThemeConfig \| true`                                                  | Theme config (`createRouter({ theme })` shape) to wrap the tree in a `ThemeProvider`. Defaults to no provider. A component calling `useTheme()` REQUIRES one.                                                                                 |
| `nonce`           | `string`                                                               | CSP nonce to seed via `NonceContext`, so a component calling `useNonce()` (e.g. an analytics/GTM head script) sees it — mirroring SSR. Defaults to `undefined` (the browser default).                                                         |
| `defaultPrefetch` | `PrefetchStrategy`                                                     | Router default for `<Link>` and eligible plain anchors. `data-prefetch="false"`/`"none"` opts out one anchor; ancestor `data-prefetch-scope="false"`/`"none"` hard-disables the subtree; `"true"` permits routed resource suffixes elsewhere. |

`RenderRouteSpec = { path, Component, layout?, loaderIds?, name? }` — one node of the route definition. The array is the layout chain root-to-leaf; the LAST entry is the leaf route (its pattern is matched against `request` to extract params; layout patterns are informational). `loaderIds` attaches seeded loaders to THIS node's segment; `layout` on the leaf wraps it; `name` is informational.

### Context — client hooks it makes resolve (what your code receives)

| Hook                           | Meaning                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `useParams`                    | Params from the matched leaf pattern, with `options.params` merged over.                      |
| `useReverse`                   | Reverse a name->pattern map to a URL; merges `useParams()` and the `mount`/`basename` prefix. |
| `useHref`                      | Resolve an href against the mount/basename.                                                   |
| `useMount`                     | The `include()` mount prefix (`options.mount`), else `"/"`.                                   |
| `useNavigation`                | Navigation controller state — stays `idle` (see caveat).                                      |
| `useRouter`                    | The router handle, including `.basename`.                                                     |
| `usePathname`                  | Current committed pathname.                                                                   |
| `useSearchParams`              | Search params from the `request` URL.                                                         |
| `useNonce`                     | SEEDED CSP nonce (`options.nonce`), else `undefined` (the browser default).                   |
| `useLoader` / `useFetchLoader` | SEEDED loader data (read path, not run path).                                                 |
| `useLocationState`             | SEEDED `history.state` value.                                                                 |
| `useHandle`                    | SEEDED handle output (globally accumulated).                                                  |
| `Outlet`                       | Renders the next segment in the chain (layout nesting).                                       |
| `useTheme`                     | Theme; throws without `options.theme` (see caveat).                                           |

### Returns — `RenderRouteResult`

Extends RTL's `RenderResult` (`getByTestId`, `getByText`, `getByRole`, `container`, ...) with:

```ts
type RenderRouteResult = RenderResult & {
  router: {
    navigate(url: string): Promise<void>; // client-only nav, re-resolves the same routes
    pathname(): string;
    params(): Record<string, string>;
    store: NavigationStore; // advanced
    eventController: EventController; // advanced
  };
};
```

## Recipe

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { Outlet, useParams, useReverse } from "@rangojs/router/client";

afterEach(cleanup);

function Layout() {
  return (
    <div>
      <span data-testid="shell">shell</span>
      <Outlet />
    </div>
  );
}
function Product() {
  const { productId } = useParams<{ productId: string }>();
  const reverse = useReverse({ product: "/products/:productId" });
  return (
    <a data-testid="link" href={reverse("product", { productId: "2" })}>
      {productId}
    </a>
  );
}

it("resolves params + reverse + Outlet through the layout chain", async () => {
  const { getByTestId, router } = await renderRoute(
    [
      { path: "/products", Component: Layout }, // layout (root)
      { path: "/products/:productId", Component: Product }, // leaf (last)
    ],
    { request: "/products/1" },
  );
  expect(getByTestId("shell").textContent).toBe("shell");
  expect(getByTestId("link").getAttribute("href")).toBe("/products/2");

  await router.navigate("/products/2"); // client-only nav, re-resolves the same routes
  expect(router.pathname()).toBe("/products/2");
});
```

## Caveats

- Client tree ONLY. Does NOT catch server/client boundary reference-identity remount bugs, real Flight serialization errors, loader execution, middleware, or handler ordering — those are `renderServerTree` / `renderHandler` / e2e territory. Loader data is SEEDED, never run.
- `router.navigate()` bypasses the navigation lifecycle, so the controller never leaves `idle`. `useNavigation()` / `useLinkStatus()` / `useAction()` non-idle states (loading/streaming/pending, action result/error) are NOT reachable — test those at e2e.
- CATCH — streaming `use(promise)` Suspense content (e.g. an async breadcrumb `content: Promise<ReactNode>`): a plain `Promise.resolve(node)` does NOT flush its Suspense retry in RTL/happy-dom, so the DOM stays on the fallback. Assert the PENDING fallback with `new Promise(() => {})`; for the ARRIVED state pass an already-settled promise so `use()` reads it synchronously: `const p = Promise.resolve(node) as any; p.status = "fulfilled"; p.value = node;`. The real pending->resolved transition is an e2e concern.
- ARIA gotcha — an explicit `role` on a `<Link>` (e.g. `<Link role="tab">` in a tablist) OVERRIDES the implicit `link` role, so `getByRole("link")` finds nothing. Query the explicit role (`getByRole("tab")`) or fall back to `getByText` / `getByTestId` and assert `getAttribute("href")`.
- `ctx.theme` is undefined unless `theme` is passed; the typed `ctx.search` defaults to `{}` (seed `searchData` on `runLoader`, not here).
- Use `mount` only for an `include()` prefix. An OPTIONAL param in the matched pattern (`/:locale?/c/:group` at `/en/c/wine`) auto-fills `locale` from the match — production parity, `useReverse` merges `useParams()` — so no `mount` is needed; a locale "dropping" from a reversed URL is usually a missing `mount` seed, not an auto-fill gap.
- Needs a DOM env (`// @vitest-environment happy-dom`, or jsdom) and `@testing-library/react` (optional peers).
- Don't hand-roll a `NavigationProvider`/router-context mock to test a client component — `renderRoute` mounts the REAL provider, so a hand-mock both duplicates effort and drifts from the production context shape.
- MULTI-APP `href` typing. When a `renderRoute` suite imports client components across apps, the global `Rango.GeneratedRouteMap` augmentations collide and `href()` stops typechecking (app A's route union rejects app B's name). Runtime is unaffected — it is purely the global `href` typing. Keep the suite single-app, or split tsconfig programs per app (see [`./reverse-and-types.md`](./reverse-and-types.md) and `/typesafety`).

## See also

- `/hooks` — the DSL this tests
- Siblings: `./handles.md`, `./reverse-and-types.md`, `./render-handler.md`, `./e2e-parity.md`
- Long-form prose: [docs/testing.md](https://github.com/ivogt/vite-rsc/blob/main/packages/rangojs-router/docs/testing.md) — section "Reverse and components" (and the "Catch: streaming `use(promise)` Suspense content" subsection)
