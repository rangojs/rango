# Testing a client component — renderRoute

**Layer:** unit (DOM) · **Import:** `@rangojs/router/testing/dom` · **DSL it tests:** a client component reading router context (see `/hooks`)

`renderRoute(routes, options?)` is an RTL-style stub (peer of React Router's `createRoutesStub` / Expo's `renderRouter`), and it is async — `await` it. It mounts the router's REAL `NavigationProvider` plus a synthetic segment tree built from the `routes` you pass, so client hooks resolve against production context — no server, no Vite build, no Flight round-trip. Loader data, location state, and handle output are SEEDED into client context; nothing is executed. With `hydrate: true` it renders that same tree to HTML first and hydrates it ([Hydration](#hydration)).

## API

### Options — `RenderRouteOptions`

| Field             | Type                                                                   | Meaning                                                                                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`         | `Request \| string`                                                    | Initial location. Only the URL is read (client render — headers/method ignored). Defaults to the leaf spec's static prefix or `"/"`.                                                                                                                        |
| `loaderData`      | `Record<string, unknown>`                                              | Loader data keyed by loader `$$id`. `useLoader(L)` reads `loaderData[L.$$id]`.                                                                                                                                                                              |
| `outletPending`   | `boolean`                                                              | Seed `useOutlet().pending` through each synthetic segment's production `OutletProvider`. Defaults to `false`; this is context seeding, not a simulated navigation/Suspense/action lifecycle.                                                                |
| `loaders`         | `ReadonlyArray<readonly [LoaderDefinition<any>, unknown]>`             | Seed by REFERENCE: `[loader, data]` pairs. Robust for real `createLoader()` handles whose `$$id` is empty in a bare test. Prefer over `loaderData`.                                                                                                         |
| `params`          | `Record<string, string>`                                               | Explicit params, merged over (and overriding) params extracted from the `request` URL.                                                                                                                                                                      |
| `locationState`   | `ReadonlyArray<readonly [LocationStateDefinition<any, any>, unknown]>` | Seed `useLocationState(def)` by REFERENCE: `[def, value]` pairs; keys an unkeyed `def` (like `withLocationStateKey(def)`) and writes the slot to `history.state` through `def`, so `value` is never the stored form. See [Location state](#location-state). |
| `handles`         | `ReadonlyArray<readonly [Handle<any, any>, unknown[]]>`                | Seed `useHandle(handle)` by REFERENCE: `[handle, pushedValues[]]`. Accumulated GLOBALLY (not segment-scoped).                                                                                                                                               |
| `handle`          | `HandleDataSeed`                                                       | Advanced: raw wire format `{ [handleId]: { [segmentId]: pushedValues[] } }`. Prefer `handles`. Merged with it.                                                                                                                                              |
| `routeMap`        | `Record<string, string>`                                               | Name -> pattern map (informational; client `useReverse` takes its map as an argument, so this is not consumed).                                                                                                                                             |
| `basename`        | `string`                                                               | `createRouter({ basename })` value. Wired into `NavigationProvider` so `useRouter().basename`, `<Link>` prefixing, `useMount`/`useHref` resolve against the mount. Normalized like `createRouter`. Defaults to root.                                        |
| `mount`           | `string`                                                               | `include()` mount prefix. Wraps the segment chain in a `MountContext` so `useMount()` returns the prefix. Normalized like a path prefix. Defaults to `"/"`.                                                                                                 |
| `theme`           | `ThemeConfig \| true`                                                  | Theme config (`createRouter({ theme })` shape) to wrap the tree in a `ThemeProvider`. Defaults to no provider. A component calling `useTheme()` REQUIRES one.                                                                                               |
| `nonce`           | `string`                                                               | CSP nonce to seed via `NonceContext`, so a component calling `useNonce()` (e.g. an analytics/GTM head script) sees it — mirroring SSR. Defaults to `undefined` (the browser default).                                                                       |
| `defaultPrefetch` | `PrefetchStrategy`                                                     | Router default for `<Link>` and eligible plain anchors. `data-prefetch="false"`/`"none"` opts out one anchor; ancestor `data-prefetch-scope="false"`/`"none"` hard-disables the subtree; `"true"` permits routed resource suffixes elsewhere.               |
| `hydrate`         | `boolean`                                                              | Render the same tree to HTML first (`renderToString`, no `window`/`document`), then hydrate that HTML instead of mounting fresh. The result gains `serverHtml` and `recoverableErrors`. See [Hydration](#hydration).                                        |

`RenderRouteSpec = { path, Component, layout?, loaderIds?, name?, transition? }` — one node of the route definition. The array is the layout chain root-to-leaf; the LAST entry is the leaf route (its pattern is matched against `request` to extract params; layout patterns are informational). `loaderIds` attaches seeded loaders to THIS node's segment; `layout` on the leaf wraps it; `name` is informational. `transition` is the `transition()` config this node declares (`{}` for a bare `transition()`), attached to its segment exactly as the DSL does — see [Held navigation](#held-navigation).

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
| `useLoader` / `useFetchLoader` | SEEDED loader data (read path, not run path). Held-navigation `isLoading` is modeled (below). |
| `useLocationState`             | SEEDED `history.state` value, or the `state` a push/replace/`<Link>` wrote (below).           |
| `useHandle`                    | SEEDED handle output (globally accumulated).                                                  |
| `Outlet`                       | Renders the next segment in the chain (layout nesting).                                       |
| `useOutlet`                    | Next-segment `content` plus SEEDED `options.outletPending`.                                   |
| `useTheme`                     | Theme; throws without `options.theme` (see caveat).                                           |

### Returns — `RenderRouteResult`

Extends RTL's `RenderResult` (`getByTestId`, `getByText`, `getByRole`, `container`, ...) with:

```ts
type RenderRouteResult = RenderResult & {
  router: {
    // client-only nav, re-resolves the same routes; `loaders` seeds THIS nav.
    // A spec's transition({ when }) decides it as kind "push";
    // `transition: false` commits urgently and calls no predicate.
    navigate(
      url: string,
      options?: {
        loaders?: ReadonlyArray<readonly [LoaderDefinition<any>, unknown]>;
        transition?: boolean;
      },
    ): Promise<void>;
    // re-render the current location, as router.refresh() does:
    // a spec's when gets kind "revalidate" (`to` is `from`)
    refresh(): Promise<void>;
    pathname(): string;
    params(): Record<string, string>;
    store: NavigationStore; // advanced
    eventController: EventController; // advanced
  };
};

// With `hydrate: true` (see Hydration):
type RenderRouteHydrateResult = RenderRouteResult & {
  serverHtml: string; // what the server pass rendered, as placed in the container
  recoverableErrors: string[]; // messages React passed to onRecoverableError (live)
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

## Location state

A `createLocationState()` definition gets its key from the rango Vite plugin, which a bare Vitest project does not run. Outside production an unkeyed definition throws on first use (`Def(value)`, `useLocationState(Def)`, `.read()`), with a message that points here. Key it with `withLocationStateKey` from `@rangojs/router/testing`:

- `withLocationStateKey(GridState, "GridState")` sets `__rsc_ls_GridState` (stable across runs).
- `withLocationStateKey(GridState)` keeps a key that is already set, else assigns a synthetic `__rsc_ls_test_<n>` that stays the same for that definition.
- The `locationState` seed option keys an unkeyed definition the same way, so a seeded definition needs no call. Key every definition a component reads WITHOUT a seed.

A `useRouter().push/replace(url, { state })` or `<Link state>` navigation writes its history entry through production's path (`resolveNavigationState` -> `buildHistoryState` -> `pushHistoryWithIdx`, then the `__rsc_locationstate` event), so `useLocationState(Def)` re-reads after the click. The dev check for a bare entry or an uncalled definition runs too, and, as in production, a push or `<Link>` without `state` starts an entry with no location state. The URL in `window.location` does not change (renderRoute tracks location on its event controller), and `router.navigate()` from the test leaves `history.state` alone. The click starts an async navigation, so wait for the result with RTL's `waitFor`:

```tsx
// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { withLocationStateKey } from "@rangojs/router/testing";
import { renderRoute } from "@rangojs/router/testing/dom";
import { LoadMore } from "../src/components/LoadMore"; // router.replace(url, { state: [GridState(...)] })
import { GridState } from "../src/location-states";

afterEach(cleanup);
withLocationStateKey(GridState, "GridState");

it("shows the count it pushed", async () => {
  const { getByTestId } = await renderRoute(
    [{ path: "/grid", Component: LoadMore }],
    { request: "/grid" },
  );
  fireEvent.click(getByTestId("load-more"));
  await waitFor(() => expect(getByTestId("count").textContent).toBe("40"));
  expect(window.history.state).toMatchObject({
    __rsc_ls_GridState: { count: 40 },
  });
});
```

### Definitions with `version`, `validate` or `clearOnReload`

A seed is the value you would pass to the definition, never the stored form: `locationState: [[GridState, { count: 3 }]]` works whatever options `GridState` has, because renderRoute writes the slot through the definition. What lands in `history.state` is what its writers store: the raw value, or `{ __rsc_ls_env: 1, v, clearOnReload, value }` for a definition with `version` or `clearOnReload` (see `/hooks`, state.md). Assert what the component shows, or read the slot back with `GridState.read()`; assert the stored object only when the stored form is the point.

| To test                                                    | Do                                                                                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the reader ignores state from another `version`            | key the older definition onto the same slot (`withLocationStateKey(GridV1, "GridState")`) and seed through it: `locationState: [[GridV1, oldValue]]`                               |
| the reader ignores a value `validate` rejects or throws on | seed that value: `locationState: [[GridState, badValue]]` (a seed's value is `unknown`, so no cast is needed)                                                                      |
| `clearOnReload` state after a client navigation            | plain `renderRoute(routes, { locationState })`: the tree mounts as during a navigation, the seed is applied                                                                        |
| `clearOnReload` state after a refresh                      | `renderRoute(routes, { hydrate: true, locationState })`: a document load of the seeded entry. The slot is removed before hydration, by the same function production start-up calls |

```tsx
// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { ProductList } from "../src/components/ProductList"; // the "load more" list of /hooks state.md: useLoader(ProductsLoader) + useLocationState(CarriedProducts)
import { ProductsLoader } from "../src/loaders";
import { CarriedProducts } from "../src/location-states"; // createLocationState<Product[]>({ clearOnReload: true })

afterEach(cleanup);
const routes = [{ path: "/products", Component: ProductList }];
const carried = [{ id: "p1", name: "Wine" }];
const loaders = [[ProductsLoader, { page: 6, products: [] }]] as const; // this page's own products: none, to count only carried ones

it("shows the carried products after a client navigation", async () => {
  const { getAllByRole } = await renderRoute(routes, {
    loaders,
    locationState: [[CarriedProducts, carried]],
  });
  expect(getAllByRole("listitem")).toHaveLength(1);
});

it("drops them on a refresh and carries again on the next navigation", async () => {
  const { recoverableErrors, queryAllByRole, getByText } = await renderRoute(
    routes,
    { loaders, hydrate: true, locationState: [[CarriedProducts, carried]] },
  );
  expect(recoverableErrors).toEqual([]);
  expect(queryAllByRole("listitem")).toHaveLength(0);
  expect(CarriedProducts.read()).toBeUndefined(); // removed from history.state

  fireEvent.click(getByText("Load more"));
  await waitFor(() => expect(CarriedProducts.read()).toBeDefined());
});
```

## Hydration

A plain `renderRoute` mounts with `createRoot`, so a component never runs its hydration render: `useSyncExternalStore` skips `getServerSnapshot`, and nothing compares the first client render with server HTML. `hydrate: true` runs the document-load sequence instead. renderRoute renders the same element (same providers, seeds, and RTL `reactStrictMode`) to HTML with `react-dom/server`'s `renderToString`, puts that HTML in the container, and hydrates it through RTL (`render(ui, { hydrate: true, onRecoverableError })`), so `cleanup()` unmounts it like any other render. `serverHtml` is what the server pass produced; `recoverableErrors` holds the message of every error React recovered from, which is where a hydration mismatch arrives.

```tsx
// @vitest-environment happy-dom
import { Suspense } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderRoute } from "@rangojs/router/testing/dom";
import { Grid } from "../src/components/Grid"; // <p data-testid="count">{useLocationState(GridState)?.count ?? 0}</p>
import { GridState } from "../src/location-states";

afterEach(cleanup);

// A <Suspense> boundary hydrates after the root has marked the page hydrated,
// as a streamed boundary does in production.
function GridPage() {
  return (
    <Suspense fallback={null}>
      <Grid />
    </Suspense>
  );
}

it("hydrates as the server rendered it, then shows the stored count", async () => {
  const { serverHtml, recoverableErrors, getByTestId } = await renderRoute(
    [{ path: "/grid", Component: GridPage }],
    { hydrate: true, locationState: [[GridState, { count: 3 }]] },
  );
  expect(serverHtml).toContain('<p data-testid="count">0</p>'); // no history.state on the server
  expect(recoverableErrors).toEqual([]); // the first client render matched it
  expect(getByTestId("count").textContent).toBe("3"); // then the stored value
});
```

| In your component                                                                     | Under `hydrate: true`                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typeof window` / `typeof document` in render                                         | `"undefined"` in the server pass: both globals are removed for it and restored before hydration. A branch renders its server side; if the client side differs, React reports the mismatch.                                                   |
| An unguarded `window.x` / `document.x` in render                                      | Throws `ReferenceError` in the server pass, as in SSR. Inside a `<Suspense>` the boundary is client-rendered and reported; outside one `renderRoute` rejects.                                                                                |
| `useSyncExternalStore`                                                                | The server pass and the hydration render read `getServerSnapshot`; the render after it reads `getSnapshot`.                                                                                                                                  |
| A text or element mismatch                                                            | React re-renders that tree on the client and reports it: `recoverableErrors` gets `"Hydration failed because ..."` with the diff.                                                                                                            |
| An attribute-only mismatch (`className`, `href`)                                      | NOT in `recoverableErrors`. React keeps the server attribute and logs `console.error` in development; assert it with `vi.spyOn(console, "error")`.                                                                                           |
| `<Suspense>` whose content renders synchronously                                      | In `serverHtml`. It hydrates in a later pass than the tree above it, after that tree's effects, before `renderRoute` resolves.                                                                                                               |
| Content that suspends in the server pass (`lazy`, a pending or plain `use()` promise) | NOT hydrated: `serverHtml` has the fallback, the client renders the content, and `recoverableErrors` reports the boundary. With no `<Suspense>` above it `renderRoute` rejects. A settled promise (Caveats, below) stays in the server HTML. |
| Render counts and module state                                                        | Every component renders once in the server pass before its hydration render. Both passes share one module realm, so module state written while rendering is still there at hydration.                                                        |
| `history`, `localStorage`, `navigator` read outside a server snapshot                 | FIDELITY LIMIT: still defined in the server pass (only `window` and `document` are removed), so the read renders the same in both passes here and can still mismatch in real SSR.                                                            |
| `data-hydrated` on `<html>`                                                           | Set after hydration, as the production root sets it from its effect, and removed on unmount. A `<Suspense>` boundary therefore hydrates with it already set.                                                                                 |
| `useLocationState` of a seeded definition                                             | `undefined` in the server pass and the hydration render, the seeded value on the render after. A `clearOnReload` definition stays `undefined`: its seeded slot is removed from `history.state` before hydration, as on a real document load. |

- Needs `@testing-library/react` 16.2.0 or newer. 16.0 and 16.1 never pass `onRecoverableError` to `hydrateRoot`, so a mismatch would be invisible; `renderRoute` throws there instead.
- `recoverableErrors` is live: React appends to it for as long as the root is mounted.
- The server pass is the HTML render of the CLIENT tree. It runs no handler, loader, middleware, or Flight, and it is not the streamed document: streaming order, client-reference identity, and the browser's HTML parser stay at e2e.

## Held navigation

A stale indicator driven by `useLoader().isLoading` (see `/hooks` data.md, "A held navigation flags the data it keeps on screen") IS unit-testable. Put `transition` on the spec that declares `transition()` in your `urls()`, and pass the next navigation's loader data to `router.navigate(url, { loaders })` as a PENDING Promise. navigate() then commits through production's `commitInTransition` (browser/partial-update.ts), which calls `loaderStore.announcePendingStreams` inside the `startTransition`. The harness does not fake the flag: React holds the reader on screen and the real `useLoader` pin reports `isLoading: true` until the promise settles.

```tsx
import { act } from "@testing-library/react";
import { useLoader } from "@rangojs/router/client";
import { ProductLoader } from "../loaders/product"; // path("/products/:id", ..., () => [loader(ProductLoader), transition()])

function ProductPrice() {
  const { data, isLoading } = useLoader(ProductLoader);
  return (
    <p data-testid="price" aria-busy={isLoading}>
      {data.price}
    </p>
  );
}

it("dims the held price while the next product streams", async () => {
  const { getByTestId, router } = await renderRoute(
    [{ path: "/products/:id", Component: ProductPrice, transition: {} }],
    { request: "/products/1", loaders: [[ProductLoader, { price: 10 }]] },
  );

  let resolve!: (value: { price: number }) => void;
  const next = new Promise<{ price: number }>((r) => (resolve = r));
  await router.navigate("/products/2", { loaders: [[ProductLoader, next]] });
  expect(getByTestId("price").getAttribute("aria-busy")).toBe("true"); // old price, stale

  await act(async () => resolve({ price: 12 })); // settle INSIDE act to flush the commit
  expect(getByTestId("price").getAttribute("aria-busy")).toBe("false");
  expect(getByTestId("price").textContent).toBe("12");
});
```

| Pending state                                                                                  | Under `renderRoute`                                                                                                                                            |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useLoader().isLoading` on the reader a `transition` navigate() holds, pending seed            | Modeled: `true` on the OLD data until the promise settles, then `false` with the new data in the same commit.                                                  |
| `transition` navigate(), settled seed (a plain value)                                          | `false`; the data swaps in the commit.                                                                                                                         |
| navigate() without `transition`, pending seed                                                  | Urgent commit (production's cold-navigation lane): the read suspends to the nearest `<Suspense>` fallback (with none, React keeps the previous tree). No flag. |
| `transition: { when }` returning false, or `navigate(url, { transition: false })`              | Same as without `transition`: urgent, with production's decision (`kind: "push"`; `refresh()` is `"revalidate"`). `transition: false` calls no predicate.      |
| Production's other hold lanes (same-structure search/filter nav, fully-prefetched, optimistic) | NOT modeled — without `transition` navigate() stays urgent. Assert those at e2e.                                                                               |
| `useNavigation().state`, `useLinkStatus().pending`, `useAction().state`                        | Stay `idle` — navigate() never starts the navigation lifecycle. e2e.                                                                                           |

- Per-navigation seeds merge over the render-time `loaders`/`loaderData` for THAT navigation only; a later `navigate()` without `loaders` falls back to the render-time data.
- Pass settled data as a plain value, not `Promise.resolve(value)`: React has not observed a plain promise yet, so it counts as pending and renders one `stale` frame. (A Flight chunk that has already settled carries its status and is skipped, which a plain value mirrors.)
- `loading()` is not a spec field: a `<Suspense>` in your layout component stands in for it.

## Caveats

- Client tree ONLY. Does NOT catch server/client boundary reference-identity remount bugs, real Flight serialization errors, loader execution, middleware, or handler ordering — those are `renderServerTree` / `renderHandler` / e2e territory. Loader data is SEEDED, never run. `hydrate: true` adds an HTML pass of this same client tree ([Hydration](#hydration)), not a render of your routes on a server.
- `router.navigate()` bypasses the navigation lifecycle, so the controller never leaves `idle`. `useNavigation()` / `useLinkStatus()` / `useAction()` non-idle states (loading/streaming/pending, action result/error) are NOT reachable — test those at e2e. The one modeled pending state is held-navigation `useLoader().isLoading` ([Held navigation](#held-navigation)).
- `outletPending` seeds only the production-shaped outlet context. It is useful
  for the two settled render states of a layout that reads `useOutlet()`, but it
  does not prove the hydrated `clientUrls()` transition that toggles the value;
  keep that transition in dev + production e2e.
- CATCH — streaming `use(promise)` Suspense content (e.g. an async breadcrumb `content: Promise<ReactNode>`): a plain `Promise.resolve(node)` does NOT flush its Suspense retry in RTL/happy-dom, so the DOM stays on the fallback. Assert the PENDING fallback with `new Promise(() => {})`; for the ARRIVED state pass an already-settled promise so `use()` reads it synchronously: `const p = Promise.resolve(node) as any; p.status = "fulfilled"; p.value = node;`. The real pending->resolved transition is an e2e concern.
- ARIA gotcha — an explicit `role` on a `<Link>` (e.g. `<Link role="tab">` in a tablist) OVERRIDES the implicit `link` role, so `getByRole("link")` finds nothing. Query the explicit role (`getByRole("tab")`) or fall back to `getByText` / `getByTestId` and assert `getAttribute("href")`.
- `useTheme()` throws unless `theme` is passed (it needs the `ThemeProvider` that option mounts). Search state comes only from the `request` URL — there is no typed-search seed here (that is `runLoader`'s `searchData`).
- Use `mount` only for an `include()` prefix. An OPTIONAL param in the matched pattern (`/:locale?/c/:group` at `/en/c/wine`) auto-fills `locale` from the match — production parity, `useReverse` merges `useParams()` — so no `mount` is needed; a locale "dropping" from a reversed URL is usually a missing `mount` seed, not an auto-fill gap.
- Needs a DOM env (`// @vitest-environment happy-dom`, or jsdom) and `@testing-library/react` (optional peers; `hydrate` needs 16.2.0 or newer).
- Don't hand-roll a `NavigationProvider`/router-context mock to test a client component — `renderRoute` mounts the REAL provider, so a hand-mock both duplicates effort and drifts from the production context shape.
- MULTI-APP `href` typing. When a `renderRoute` suite imports client components across apps, the global `Rango.GeneratedRouteMap` augmentations collide and `href()` stops typechecking (app A's route union rejects app B's name). Runtime is unaffected — it is purely the global `href` typing. Keep the suite single-app, or split tsconfig programs per app (see [`./reverse-and-types.md`](./reverse-and-types.md) and `/typesafety`).

## See also

- `/hooks` — the DSL this tests
- Siblings: `./handles.md`, `./reverse-and-types.md`, `./render-handler.md`, `./e2e-parity.md`
- Long-form prose: [docs/testing.md](https://github.com/rangojs/rango/blob/main/packages/rangojs-router/docs/testing.md) — section "Reverse and components" (and the "Catch: streaming `use(promise)` Suspense content" subsection)
