---
name: view-transitions
description: Configure React View Transitions on layouts, routes, and parallel slots in @rangojs/router. Use when navigation should animate smoothly between pages, or wiring up React View Transitions on a route or layout.
argument-hint: [layout|route|parallel|intercept]
---

# View Transitions

`transition()` opts a route (or group of routes) into transition-driven navigation. It does two things, and you choose how far to go:

1. **`startTransition` (the foundation).** The navigation commit is driven through React's `startTransition`. That holds the previous content across a same-route navigation (stale-while-revalidate — no loading-skeleton flash) and is the **precondition** for any view-transition animation. Works on **all** React versions.
2. **`<ViewTransition>` (the animation, layered on top).** On experimental React, rango also wraps the segment content in React's `<ViewTransition>` so the swap cross-fades/morphs. This is the only part that needs experimental React; pass `viewTransition: false` to keep #1 without it (and place your own `<ViewTransition>` where you want it).

> The `<ViewTransition>` layer requires React experimental (the build that exports `<ViewTransition>` / `addTransitionType`). On stable React that layer is a no-op — but the `startTransition` driving (content hold) still applies.

## Purpose: `startTransition` vs `<ViewTransition>`

These are two **independent** mechanisms. `startTransition` controls _fallbacks_ (hold the old content vs. flash the Suspense skeleton) and is what lets a view transition fire at all; the `<ViewTransition>` boundary is the _visual cross-fade_.

|                            | `startTransition` **OFF**                                                      | `startTransition` **ON**                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **`<ViewTransition>` OFF** | plain nav — remount on param change, skeleton flash, no animation              | **hold** content (no skeleton flash); a consumer-placed `<ViewTransition>` still morphs; no router cross-fade |
| **`<ViewTransition>` ON**  | **impossible** — React never activates `<ViewTransition>` outside a Transition | hold + router cross-fade                                                                                      |

The bottom-left cell is the key constraint: a view transition cannot exist without a `startTransition`. So once you reach for `transition()`, the only real choice is _startTransition_ vs _startTransition + ViewTransition_:

| What you want                          | Config                                              | Effect                                                                                                 |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| nothing (default nav)                  | no `transition()`                                   | remount + skeleton on param change                                                                     |
| `startTransition` only                 | `transition({ viewTransition: false })`             | hold content; place your own `<ViewTransition>` where you want it                                      |
| `startTransition` + `<ViewTransition>` | `transition({})` / `transition({ enter, exit, … })` | hold + router cross-fade (experimental React; on stable it degrades to the `startTransition`-only row) |

`createRouter({ viewTransition: "auto" \| false })` sets the app-wide default for the third row; a per-segment `viewTransition` wins. See [Opting out of the router boundary](#opting-out-of-the-router-boundary-place-your-own-viewtransition) for the full opt-out story.

## What `transition()` does (wrap location)

`transition(config)` attaches a [`TransitionConfig`](#transitionconfig) to the surrounding entry. Where the wrap actually lands in the rendered React tree depends on the segment type:

| Segment type                      | Wrap location                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout()`                        | Around the layout's **default outlet content** (what the layout's `<Outlet />` renders), recursively pushed past nested layouts. Parallel slots (`<ParallelOutlet />`) are siblings of the wrap, not subtree members.                                                                                                             |
| `path()` / `route()`              | Around the **route's component itself** (the leaf content).                                                                                                                                                                                                                                                                       |
| `parallel()` / `intercept()` slot | `transition()` is accepted by the DSL today, but slot-level rendering does not currently apply a `<ViewTransition>` wrapper. Mount intercept slots in layouts so layout transitions stay scoped to the default outlet. For modal-specific morphs today, use an element-level React `<ViewTransition>` inside the modal component. |

The layout case is the important one: stacking a layout transition does **not** wrap the layout chrome (header, sidebar, modal slot); it only morphs whatever flows through that layout's `<Outlet />`.

## Basic Usage

A simple cross-fade between pages that share a layout:

```tsx
import { urls } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";

function ShopShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shop">
      <NavBar />
      <main>
        <Outlet /> {/* fade applies HERE */}
      </main>
      <Footer />
    </div>
  );
}

export const urlpatterns = urls(({ layout, path, transition }) => [
  layout(<ShopShell />, () => [
    transition({ default: "page-fade" }),
    path("/", ShopIndex, { name: "index" }),
    path("/about", AboutPage, { name: "about" }),
    path("/contact", ContactPage, { name: "contact" }),
  ]),
]);
```

```css
::view-transition-old(root) {
  animation: fade-out 200ms ease both;
}
::view-transition-new(root) {
  animation: fade-in 200ms ease both;
}
.page-fade {
  /* class hooks per phase */
}
```

Navigating between `/`, `/about`, and `/contact` morphs the `<Outlet />` content with the `page-fade` class. The shell (NavBar, Footer) does not morph because the wrap sits inside the shell, not around it.

## Direction-aware transitions

`ViewTransitionClass` accepts an object form keyed by transition type. Rango tags forward navigations as `"navigation"` and back/forward popstate as `"navigation-back"`:

```tsx
layout(<ShopShell />, () => [
  transition({
    default: {
      navigation: "slide-left",
      "navigation-back": "slide-right",
    },
  }),
  path("/", ShopIndex, { name: "index" }),
  path("/about", AboutPage, { name: "about" }),
]);
```

```css
.slide-left {
  animation-name: slide-from-right;
}
.slide-right {
  animation-name: slide-from-left;
}
```

> Note: `"action"` is only tagged on partial-update action/refetch paths today; ordinary `server-action-bridge` commits (`useAction` / `useActionState` revalidations) are not currently tagged. Don't rely on an `action`-keyed class to fire on every form action.

## Wrapper form: applying transition to a group of routes

`transition(config, () => [...])` creates a transparent layout that applies the config to its children — useful when you want a transition without authoring a real layout component:

```tsx
urls(({ path, transition }) => [
  // No layout component, but every route inside gets the fade.
  transition({ default: "fade" }, () => [
    path("/", HomePage, { name: "home" }),
    path("/about", AboutPage, { name: "about" }),
  ]),
  // Outside the wrapper — no transition applied.
  path("/admin", AdminPage, { name: "admin" }),
]);
```

## Intercept (modal) interaction

This is where the rango-specific behavior pays off. A common shape:

```tsx
import { urls } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

function GalleryShell() {
  return (
    <>
      <NavBar />
      <main>
        <Outlet /> {/* page transition lands here */}
      </main>
      <ParallelOutlet name="@modal" />{" "}
      {/* modal mounts here — sibling of the VT */}
    </>
  );
}

export const urlpatterns = urls(
  ({ layout, path, intercept, transition, loader, loading }) => [
    layout(<GalleryShell />, () => [
      transition({ default: "fade" }),

      path("/", GalleryFeed, { name: "feed" }),
      path("/photos/:id", PhotoPage, { name: "photo" }),

      intercept("@modal", "photo", <PhotoModal />, () => [
        loader(PhotoLoader),
        loading(<PhotoModalSkeleton />),
      ]),
    ]),
  ],
);
```

| Action                                          | What fires                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Navigate `/` ↔ `/about` (within `GalleryShell`) | Layout transition fires; `<Outlet />` content cross-fades                                                                      |
| Click `<Link to="/photos/42" />` from `/`       | Soft navigation opens `<PhotoModal />` in `@modal`; **no** view transition fires on the underlying feed                        |
| Submit a form action inside `<PhotoModal />`    | Revalidation commits without firing the layout VT; modal subtree identity is preserved (no remount, `useActionState` survives) |
| Close modal via `router.back()`                 | Underlying page is restored; **no** view transition fires                                                                      |
| Direct URL load `/photos/42`                    | Renders the full `<PhotoPage />` with no modal; the layout transition applies on subsequent in-layout navs                     |

The "no VT on modal open" guarantee holds at any depth — if the layout that owns `@modal` is itself nested inside another transitioned layout, the outer transition is pushed past the inner layout into its default outlet content, so the modal slot ends up outside both VTs.

## Per-route transition

Routes are leaves: their `transition()` wraps the route component itself.

```tsx
urls(({ path, transition }) => [
  path("/checkout", CheckoutPage, { name: "checkout" }, () => [
    transition({ default: "fade-in" }),
  ]),
]);
```

This is the right level for one-off route-specific morphs that should not propagate to siblings.

## TransitionConfig

`transition()` accepts the props of React's `<ViewTransition>` (minus `children`/refs). Each phase prop accepts either a plain class string or an object keyed by transition type:

```ts
import type { TransitionConfig } from "@rangojs/router";

interface TransitionConfig {
  enter?: string | Record<string, string>;
  exit?: string | Record<string, string>;
  update?: string | Record<string, string>;
  share?: string | Record<string, string>;
  default?: string | Record<string, string>; // fallback for any phase
  name?: string; // explicit view-transition-name
  viewTransition?: "auto" | false; // boundary opt-out (see below)
  // Conditional gate, evaluated server-side AFTER the route handler. Return
  // false to drop this transition for the request, so the navigation streams its
  // loading() fallback instead of holding. See the gate section below.
  when?: (ctx: TransitionWhenContext) => boolean;
}
```

- `default` is the catch-all if a phase-specific prop is unset.
- The object form keys are React transition types tagged by rango: `"navigation"` (forward navigations), `"navigation-back"` (popstate cache restores), and `"action"` (partial-update action/refetch paths only — see the caveat in "Direction-aware transitions").
- `name` lets you participate in cross-page morphs by name (advanced; you usually don't need this on a layout/route-level wrap).
- `viewTransition` toggles whether rango places its own `<ViewTransition>` boundary. `"auto"` (default) wraps as described above; `false` opts out — see the next section.

## Conditional transitions (`when`)

`transition({ when })` gates the hold per request. The predicate runs **server-side, AFTER the route handler** and outside any cache scope; return `false` to drop this segment's transition for the request (the navigation streams its `loading()` fallback instead of holding).

Its context mirrors the `revalidate()` predicate args — the same navigation/action metadata — plus `get`/`env` for post-handler reads:

```ts
import type { TransitionWhenContext } from "@rangojs/router";

// Hold only when the handler marked this request (handler sets, gate reads):
transition({ when: (ctx) => ctx.get(KeepScroll) === true });

// Hold only when arriving from a specific page (the navigation SOURCE):
transition({
  when: ({ currentUrl }) => currentUrl?.pathname.startsWith("/list") === true,
});
transition({ when: ({ fromRouteName }) => fromRouteName === "products.list" });

// Hold only after a specific action revalidated the route:
transition({
  when: ({ actionId }) => actionId === "src/actions/cart.ts#addToCart",
});
```

| field                                                  | meaning                                      | populated                                                                             |
| ------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `currentUrl` / `currentParams` / `fromRouteName`       | navigation **source**                        | soft nav + action-success; `undefined` on initial full load and action/PE error paths |
| `nextUrl` / `nextParams`                               | navigation **target**                        | always                                                                                |
| `toRouteName` (and `fromRouteName`)                    | route **name**                               | when the route is named (undefined for unnamed/auto-generated)                        |
| `actionId` / `actionUrl` / `actionResult` / `formData` | the server action that triggered this render | action-triggered renders only                                                         |
| `method`                                               | `"GET"` (nav) / `"POST"` (action)            | always                                                                                |
| `get` / `env`                                          | read handler/middleware vars + app env       | always                                                                                |

A predicate that throws is reported to `router.onError` (phase `"rendering"`) and treated as no-hold (conservative).

**Same-route content-holds need the transition present on the FIRST render.** The same-route hold works by giving the route a param-agnostic key so a param change reconciles instead of remounting — but that key is established when the route first mounts. A source gate that returns `false` on the initial full load (where `currentUrl`/`currentParams`/`fromRouteName` are undefined) drops the transition before the route mounts, so the route mounts _outside_ a transition scope and **every** later same-route param nav remounts (flashing the skeleton) regardless of what the gate decides on those navs. Write source gates so they hold when there is no source — e.g. `({ currentParams }) => currentParams?.tab !== "raw"` (true on the initial load) rather than `=== "details"` (false on the initial load) — when the same-route content-hold must engage. This only affects same-route param navigations; action-only or cross-route gating is unaffected (no shared param key is in play).

**Prefetch / cache caveat.** The gate runs during resolution, so a **prefetched** navigation decides at prefetch time — `currentUrl`/`currentParams`/`fromRouteName` reflect the page the prefetch fired from, not necessarily the click-time source — and a `cache()`/prerender hit replays the stored transition without re-running the predicate. A source-sensitive gate can therefore be frozen to prefetch/store-time state. This covers ~99% of navigations; if yours must reflect the exact click-time source, source-scope the prefetch (`<Link prefetchKey=":source">`) and don't `cache()` that segment.

## Opting out of the router boundary (place your own `<ViewTransition>`)

By default a `transition()` segment gets a rango-placed `<ViewTransition>` boundary — a cross-fade of the whole outlet/route. If you'd rather animate specific elements yourself (place `<ViewTransition name="...">` in your components), set `viewTransition: false`. The router then contributes **no boundary of its own** but still:

- drives the navigation commit through `startTransition` (so React runs `document.startViewTransition`, and your own `<ViewTransition>` elements animate on navigation — driving is what they need, not a router boundary), and
- holds same-route content (stale-while-revalidate; no skeleton flash).

```tsx
// Router drives the transition + holds content, but places NO cross-fade.
// Only your <ViewTransition name="hero"> morphs.
urls(({ path, transition }) => [
  path("/product/:id", ProductPage, { name: "product" }, () => [
    transition({ viewTransition: false }),
  ]),
]);

// ProductPage renders the boundary itself, exactly where it's wanted:
function ProductPage() {
  return (
    <ViewTransition name="hero">
      <img src={cover} />
    </ViewTransition>
  );
}
```

This is the rango analogue of the "router triggers, you place the names" model used by React Router / TanStack: rango guarantees navigations run inside a React transition; you own the boundaries.

**App-wide default.** Flip the default for every `transition()` segment at the router level. A per-segment `viewTransition` still overrides it.

```ts
const router = createRouter<AppEnv>({ viewTransition: false });
// Now `transition({})` drives + holds but places no boundary anywhere.
// Re-enable a router boundary on one route with transition({ viewTransition: "auto" }).
```

**Precedence (per-route vs router default).** A bare `transition({})` has no per-route `viewTransition`, so it inherits the router default (`"auto"` unless `createRouter({ viewTransition: false })`). An explicit per-route value always wins. The `viewTransition` flag only toggles the boundary — `startTransition` driving and content-hold are on in every row below (they key off `transition()` presence, not this flag):

| per-route (`transition(...)`)            | router (`createRouter`) | resolved boundary        | result      |
| ---------------------------------------- | ----------------------- | ------------------------ | ----------- |
| `transition({})` (unset)                 | `"auto"` (default)      | wrap                     | **ST + VT** |
| `transition({})` (unset)                 | `false`                 | no wrap                  | **ST only** |
| `transition({ viewTransition: "auto" })` | `"auto"`                | wrap                     | ST + VT     |
| `transition({ viewTransition: "auto" })` | `false`                 | wrap (per-route wins)    | **ST + VT** |
| `transition({ viewTransition: false })`  | `"auto"`                | no wrap (per-route wins) | **ST only** |
| `transition({ viewTransition: false })`  | `false`                 | no wrap                  | ST only     |

On stable React the "VT" column is always a no-op (there is no `<ViewTransition>`), so every row collapses to its `startTransition`-only behavior there.

| Config                                               | Router boundary  | startTransition driving (no skeleton flash) | Your own `<ViewTransition name>`   |
| ---------------------------------------------------- | ---------------- | ------------------------------------------- | ---------------------------------- |
| no `transition()`                                    | —                | no                                          | does not fire on nav               |
| `transition({})` / `{ viewTransition: "auto" }`      | yes (cross-fade) | yes                                         | fires, under the router cross-fade |
| `transition({ viewTransition: false })`              | none             | yes                                         | fires alone                        |
| global `viewTransition: false`, route `transition()` | none             | yes                                         | fires alone                        |

> On **stable** React there is no `<ViewTransition>` at all, so `viewTransition: false` is visually a no-op there — but the startTransition driving and content-hold still apply, identical to `transition({})`.

## Recommendations

**Put `<ParallelOutlet />` in layouts, not routes.** A route-level `transition` wraps the route component itself, so a `<ParallelOutlet />` rendered directly inside that route component remains inside the route VT subtree — modal opens on a route with a parallel outlet _will_ trigger the route's VT walker. The narrowing fix only applies at layout boundaries. If you combine intercept modals with route-level transitions, mount the slot one level up in a layout.

**Don't stack `transition()` on every layout level.** When ancestor and descendant layouts both configure transitions, both wraps end up nested around the deepest default outlet content. Two VTs fire on every nav within the inner layout. That's usually not what you want — pick the level where the morph belongs and apply it once.

**Need a modal-only morph?** Per-slot `transition()` is currently a no-op at render time, so use an element-level React `<ViewTransition>` inside the modal component (or a CSS animation) for the modal-entrance effect.

**Action revalidation inside a modal is safe.** Server-action submits inside an open modal don't fire the underlying layout VT. Modal subtree identity is preserved across revalidation — so `useActionState`, focus, and scroll all survive the round-trip.

## Notes

- `transition()` is part of the route DSL. The allow-list table in [skills/handler-use](../handler-use/SKILL.md) permits it inside `layout()`, `path()`/`route()`, `parallel()` (per-slot or shared), and `intercept()`. At render time, only the layout and route wraps actually take effect today; `parallel()`/`intercept()` slot-level rendering does not currently apply the wrap.
- Wrap location for layouts: rango walks the rendered tree past `MountContextProvider`/`OutletProvider`/`LoaderBoundary` for layout segments and applies the wrap at the first non-layout target ([segment-system.tsx](../../src/segment-system.tsx) — `wrapDefaultOutletContent`). This is what keeps parallel slots out of the VT subtree.
- Tree consistency: the wrapper structure is identical across normal commits, intercept-active commits, and action revalidations — React never sees an element-type swap, so layout/modal subtrees are not remounted across these transitions.
- Element-level `<ViewTransition>` (importing it directly from React and using `name`/`share` to morph specific elements across pages) composes with rango's segment-level wraps as usual; rango doesn't intercept those.
- See also: [skills/intercept](../intercept/SKILL.md), [skills/parallel](../parallel/SKILL.md), [skills/layout](../layout/SKILL.md).
