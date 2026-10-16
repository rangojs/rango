---
name: view-transitions
description: Configure React View Transitions on layouts, routes, and parallel slots in @rangojs/router. Use when navigation should animate smoothly between pages, or wiring up React View Transitions on a route or layout.
argument-hint: [layout|route|parallel|intercept]
---

# View Transitions

`transition()` opts a route (or group of routes) into transition-driven navigation. It does two things, and you choose how far to go:

1. **`startTransition` (the foundation).** The navigation commit is driven through React's `startTransition`. That holds the previous content across a same-route navigation (stale-while-revalidate — no loading-skeleton flash) and is the **precondition** for any view-transition animation. Works on **all** React versions. While the hold lasts, `useLoader` readers of the loaders being re-run report `isLoading: true` — keyed by loader family (`$$id`), not by segment; see the hooks skill, `data.md`.
2. **`<ViewTransition>` (the animation, layered on top).** On React 19.3+ (or an experimental build), rango also wraps the segment content in React's `<ViewTransition>` so the swap cross-fades/morphs. This is the only part that needs 19.3+; pass `viewTransition: false` to keep #1 without it (and place your own `<ViewTransition>` where you want it).

> The `<ViewTransition>` layer requires a React that exports `<ViewTransition>` / `addTransitionType`: stable 19.3+ or an experimental build. Rango feature-detects it; on React 19.2 that layer is a no-op — but the `startTransition` driving (content hold) still applies.

## Purpose: `startTransition` vs `<ViewTransition>`

These are two **independent** mechanisms. `startTransition` controls _fallbacks_ (hold the old content vs. flash the Suspense skeleton) and is what lets a view transition fire at all; the `<ViewTransition>` boundary is the _visual cross-fade_.

|                            | `startTransition` **OFF**                                                      | `startTransition` **ON**                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **`<ViewTransition>` OFF** | plain nav — remount on param change, skeleton flash, no animation              | **hold** content (no skeleton flash); a consumer-placed `<ViewTransition>` still morphs; no router cross-fade |
| **`<ViewTransition>` ON**  | **impossible** — React never activates `<ViewTransition>` outside a Transition | hold + router cross-fade                                                                                      |

The bottom-left cell is the key constraint: a view transition cannot exist without a `startTransition`. So once you reach for `transition()`, the only real choice is _startTransition_ vs _startTransition + ViewTransition_:

| What you want                          | Config                                              | Effect                                                                                                        |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| nothing (default nav)                  | no `transition()`                                   | remount + skeleton on param change                                                                            |
| `startTransition` only                 | `transition({ viewTransition: false })`             | hold content; place your own `<ViewTransition>` where you want it                                             |
| `startTransition` + `<ViewTransition>` | `transition({})` / `transition({ enter, exit, … })` | hold + router cross-fade (React 19.3+ or experimental; on 19.2 it degrades to the `startTransition`-only row) |

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

function ShopShell() {
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

The config values are React `<ViewTransition>` classes: React applies them as
`view-transition-class`, so the CSS targets the view-transition
pseudo-elements by class:

```css
::view-transition-old(.page-fade) {
  animation: 200ms ease both fade-out;
}
::view-transition-new(.page-fade) {
  animation: 200ms ease both fade-in;
}
@keyframes fade-out {
  to {
    opacity: 0;
  }
}
@keyframes fade-in {
  from {
    opacity: 0;
  }
}
```

Navigating between `/`, `/about`, and `/contact` cross-fades the `<Outlet />` content with the `page-fade` class. The shell (NavBar, Footer) does not animate because the wrap sits inside the shell, not around it.

## Direction-aware transitions

`ViewTransitionClass` accepts an object form keyed by transition type. Every commit the router runs in a transition carries its kind (`"push"`, `"replace"`, `"pop"`, `"action"`, `"revalidate"`, see [Transition kinds](#transition-kinds)). Under `transition()`, Rango also tags forward navigations as `"navigation"` and back/forward navigations restored from the client cache as `"navigation-back"` (a back/forward that has to refetch from the server is tagged `"navigation"`). The restore runs a view transition: it commits on the next task after the `popstate` event, with its saved scroll applied before the new snapshot is taken (see [Back and Forward](#back-and-forward)):

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
::view-transition-old(.slide-left) {
  animation: 250ms ease both slide-out-to-left;
}
::view-transition-new(.slide-left) {
  animation: 250ms ease both slide-in-from-right;
}
::view-transition-old(.slide-right) {
  animation: 250ms ease both slide-out-to-right;
}
::view-transition-new(.slide-right) {
  animation: 250ms ease both slide-in-from-left;
}
/* @keyframes slide-out-to-left, slide-in-from-right, ... defined as usual */
```

### Transition kinds

Every commit the router runs in a transition adds its `transition({ when })` kind as a transition type, first, before the types above. A map keyed by kind tells a link navigation from a server action's revalidation, with or without `transition()` on the route:

| Kind           | Commits                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"push"`       | A link, `router.push()`, `navigate()`: the same-route content hold (search or catch-all change), a fully prefetched click, an intercept, the commit after a `clientUrls()` optimistic swap |
| `"replace"`    | `router.replace()`, `<Link replace>`                                                                                                                                                       |
| `"pop"`        | A back/forward: one that refetches, and under `transition()` one restored from the history cache                                                                                           |
| `"action"`     | A server action's revalidation and its error-boundary commit                                                                                                                               |
| `"revalidate"` | `router.refresh()`, a stale entry's background revalidation                                                                                                                                |

```tsx
// Animate navigations; keep action revalidations and background refreshes still.
<ViewTransition update={{ push: "page", replace: "page", default: "none" }}>
  <ProductGrid />
</ViewTransition>
```

- Tagging alone animates nothing: React starts a view transition only where a `<ViewTransition>` resolves a class other than `"none"` for the commit's types.
- A commit outside a transition carries no type: a cold click that mounts new segments, a gated-off commit (`when` returned `false`), and a back/forward restored from the history cache on a route without `transition()` (it commits inside the `popstate` event). Under `transition()` that restore carries `"pop"` and `"navigation-back"`.
- Under `transition()`, a stale entry's revalidation carries `"revalidate"` and `"action"`. An `action`-keyed map that must skip it also keys `revalidate: "none"` (`"none"` wins over any other match).
- The types reach the commit that brings the page. React keeps one queue of transition types per root, and the first transition commit takes the whole queue. No router hook update takes them first: `useHandle()` and `useSegments()` commit with the page, and a `useNavigation()` value that moves while neither the state nor the URL does (`pendingUrl` as the response starts streaming, `isStreaming` as it ends) commits with the page while the reader has a held value, urgently otherwise, so it starts no view transition of its own. `useAction()` values commit urgently. `useLinkStatus()` commits `pending` urgently and its end with the page, and a newer navigation or an abort ends it urgently, outside a held commit; neither starts a transition. A transition your own code starts while React holds a navigation's page can still take them. Handle values on a held page land in the commit right after the page, by design; see [hooks](../hooks/handle-and-actions.md#when-handle-values-change-by-design). Use a kind map to choose an animation, never for correctness.

### Back and Forward

A back/forward the router restores from its history cache animates like a link under `transition()`:

- It commits on the next task after the `popstate` event, in a view transition whose types are `"pop"` and `"navigation-back"`. React commits a transition started inside the event synchronously, with no view transition, so the router waits that one task; the page being left stays on screen until then, and the location hooks change with the restored page.
- The saved scroll position is applied in the commit's layout effect, before the view transition takes its new snapshot, so the restored page animates in at the position it was left.
- A traversal the browser animated itself (`PopStateEvent.hasUAVisualTransition`: the iOS Safari and Chrome Android back swipe) commits at once and is not animated again.
- A second Back or Forward before the first one's restore commits wins; the first restore is dropped.
- Without `transition()` the restore commits inside the event, with no view transition and no type.
- So does an entry whose scroll the browser restores itself (`history.scrollRestoration` is `"auto"`: the document renders no `<Html.ScrollRestoration>`, which Rango's default document does, or the entry predates it). The browser restores that scroll right after the event, on whatever page is then on screen.

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
      {/* modal mounts here, as a sibling of the VT */}
      <ParallelOutlet name="@modal" />
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
  // Browser predicate, once per navigation: false commits it urgently with no
  // view transition. See "Conditional transitions".
  when?: (ctx: TransitionWhenContext) => boolean;
}
```

- `default` is the catch-all if a phase-specific prop is unset.
- The object form keys are React transition types tagged by rango: the commit's kind (`"push"`, `"replace"`, `"pop"`, `"action"`, `"revalidate"`, see [Transition kinds](#transition-kinds)) and, under `transition()`, `"navigation"` (forward navigations), `"navigation-back"` (popstate cache restores) and `"action"` (action and stale revalidations).
- `name` lets you participate in cross-page morphs by name (advanced; you usually don't need this on a layout/route-level wrap).
- `viewTransition` toggles whether rango places its own `<ViewTransition>` boundary. `"auto"` (default) wraps as described above; `false` opts out — see the next section.

## Conditional transitions (`when`)

`transition({ when })` decides, per navigation, whether the navigation holds.
It is a **browser** predicate: it runs once per navigation, at the first
commit that presents the destination, and never on the server, on the
document load, or on progressive-enhancement paths. Return `false` and the
navigation commits urgently: the `loading()` skeleton streams and no view
transition runs.

Write it inline in `urls()`. The Vite plugin hoists the literal into a
`"use client"` module, and the route carries it to the browser as a client
reference. The hoist applies to the router's `transition`: the `urls()`
helper (renamed or not) or `transition` imported from `@rangojs/router`,
with the function written directly as the `when` value (an arrow, a
`function`, or a `when() {}` method; `as` / `satisfies` wrappers are
fine). A config built elsewhere, such as `transition(cfg)`, is not hoisted:
export that predicate from a `"use client"` module instead.

```ts
// Hold unless the navigation leaves the "b" tab (the navigation SOURCE):
transition({ when: ({ from }) => from.params.tab !== "b" });

// Hold only for forward navigations inside /list:
transition({
  when: ({ kind, to }) => kind !== "pop" && to.url.pathname.startsWith("/list"),
});

// Hold only after a specific action revalidated the route:
transition({ when: ({ isAction }) => isAction(addToCart) });
```

For a predicate you share between routes or unit-test, export it from a
`"use client"` module and import it into the urls file:

```ts
// src/transitions.ts
"use client";
import type { TransitionWhenContext } from "@rangojs/router";
import { Slide } from "./location-states.js";

export function slideWhen({ to }: TransitionWhenContext): boolean {
  return Slide.read(to)?.animate !== false;
}

// src/urls.tsx
import { slideWhen } from "./transitions.js";
path("/photos/:id", PhotoPage, { name: "photo" }, () => [
  transition({ default: "slide", when: slideWhen }),
]);

// A Link that opts this navigation out through location state:
<Link to="/photos/2" state={[Slide({ animate: false })]}>Next</Link>;
```

Predicate modules (a `"use client"` export, or a hoisted inline literal) load
with the client entry chunk, because the router must be able to call them at
the first navigation. Keep them small: type imports and location-state
definitions only, and nothing that touches `window` at module scope (the
module is also evaluated during SSR).

The rule is "a predicate runs where its effect lands": the hold is a browser
commit decision, so the predicate runs in the browser. An inline literal may
reference module-level imports only when they are client-safe (they are
re-emitted into the hoisted module); a free server binding (a `const` in the
urls file, a handler variable, a component used as JSX) or a server-only
import is a build error that names it, and so are `import()`, `import.meta`
other than `import.meta.env`, `this` / `arguments` of the enclosing
function, and a `get when()` accessor. A server function passed by name, or a non-function, fails dev
startup, the build and HMR re-discovery with the route name and pattern.

### Context

```ts
interface RouteLocation {
  url: URL;
  params: Record<string, string>;
  routeName: string | undefined;
  state: unknown; // the entry's history.state; read slots with Def.read(location)
}

interface TransitionWhenContext {
  kind: "push" | "replace" | "pop" | "action" | "revalidate";
  from: RouteLocation; // the committed location being left
  to: RouteLocation; // the destination; === from for "action" and "revalidate"
  isAction: IsActionFn; // the revalidate() matcher; false off-action
  action?: { id; formData; result; error }; // kind "action" only
}
```

| `kind`         | started by                                           | `to.state`                                                                                                                         |
| -------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `"push"`       | `Link`, `router.push()`                              | the pushed state plus server `ctx.setLocationState()` (handler, middleware, action)                                                |
| `"replace"`    | `Link replace`, `router.replace()`                   | same as push                                                                                                                       |
| `"pop"`        | back/forward                                         | the target entry's stored state                                                                                                    |
| `"action"`     | a server action's revalidation, error boundary incl. | the current entry's state plus action-set state (none on the error lane: an error response sets no location state); `action.*` set |
| `"revalidate"` | `router.refresh()`, a stale entry's revalidation     | the current entry's state                                                                                                          |

- `Def.read(location)` reads a location-state slot from `from` or `to`
  without clearing flash state.
- Middleware-set location state reaches `to.state` on a PPR replay HIT too
  (middleware runs on every HIT); a route handler's does not, because a HIT
  runs no handler. Set it from middleware when a `ppr` route decides on it.
- A `clientUrls()` cross-route navigation decides at its optimistic swap,
  before the server responds, so its `to.state` holds only the pushed
  state.
- On `"pop"`, `from.state` and `from.routeName` come from the router's
  per-history-entry memory; after a reload they are `undefined`.
- `get()`, `env` and handler state do not exist in the browser.

### Combination and `false`

- The navigation holds only when **every** committed segment's `when`
  returns true, kept or re-sent: a layout the navigation keeps still gates
  it ([#989](https://github.com/rangojs/rango/issues/989)). The same function
  on several segments is called once.
- `false` makes the whole navigation urgent, so no segment animates. Every
  `<ViewTransition>` stays in the tree with its classes set to `"none"`, so a
  same-route navigation that flips `true -> false -> true` never remounts
  the route or loses its state
  ([#995](https://github.com/rangojs/rango/issues/995)).
- That holds for every kind, actions and revalidations included: a gated-off
  action or revalidation commit is urgent and unanimated too, and a segment it
  re-renders shows its `loading()` only while something in it is still pending
  (a gated-off navigation whose data is still streaming shows it; an action
  whose response already carries the data does not in a production build,
  while the dev server still shows it briefly because it resolves each
  response's client components asynchronously). The router commits an
  action's result after the response arrives, outside the transition React
  opens for a form action or `useActionState` call, so React does not hold it
  either.
- A predicate that throws counts as `false` and is logged with
  `console.error` (the conservative default: no hold).
- Intercept (modal) commits skip the evaluation, including a back/forward
  that opens or closes a modal.
- A stale revalidation the user navigated away from before it landed is
  discarded without calling the predicate.
- Intercept `from` differs: while a modal is open, an intercept selector's
  `from` is the page under the modal (see the intercept skill); here it is
  always the location on screen.
- In a `clientUrls()` group, `false` also opts a same-route navigation out of
  the group's default hold.

`kind` is also the transition type the commit carries (see "Transition
kinds"): `{ push: "page", default: "none" }` animates the commits `when` sees
as `"push"`. Under `transition()` the older keys stay: a `"pop"` restored from
the history cache adds `"navigation-back"` (a pop that refetches adds
`"navigation"`); `"push"`, `"replace"` and a `router.refresh()`
(`"revalidate"`) add `"navigation"`; a stale entry's revalidation adds
`"action"`.

### Opting out per navigation

`router.push(url, { transition: false })`, `router.replace(url, {
transition: false })` and `<Link transition={false}>` present one
navigation the way `when` returning `false` does, without calling any
predicate. Back/forward, actions and revalidation have no per-navigation
options and are unaffected.

```tsx
<Link to="/photos/2" transition={false}>
  Jump without the slide
</Link>
```

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

// ProductPage renders the boundary itself, exactly where it's wanted
// (ViewTransition is exported by React 19.3+ and experimental builds):
import { ViewTransition } from "react";

function ProductPage() {
  return (
    <ViewTransition name="hero">
      <img src={cover} />
    </ViewTransition>
  );
}
```

This is the rango analogue of the "router triggers, you place the names" model used by React Router / TanStack: rango guarantees navigations run inside a React transition; you own the boundaries.

On a route with `loading()` and slow loaders, `viewTransition: false` is also what removes the view transition that changes nothing; see [A view transition that changes nothing under `loading()`](#a-view-transition-that-changes-nothing-under-loading).

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

On React 19.2 (no `<ViewTransition>` export) the "VT" column is a no-op, so every row collapses to its `startTransition`-only behavior there.

| Config                                               | Router boundary  | startTransition driving (no skeleton flash) | Your own `<ViewTransition name>`   |
| ---------------------------------------------------- | ---------------- | ------------------------------------------- | ---------------------------------- |
| no `transition()`                                    | —                | no                                          | does not fire on nav               |
| `transition({})` / `{ viewTransition: "auto" }`      | yes (cross-fade) | yes                                         | fires, under the router cross-fade |
| `transition({ viewTransition: false })`              | none             | yes                                         | fires alone                        |
| global `viewTransition: false`, route `transition()` | none             | yes                                         | fires alone                        |

> On React 19.2 there is no `<ViewTransition>` at all, so `viewTransition: false` is visually a no-op there — but the startTransition driving and content-hold still apply, identical to `transition({})`.

## A view transition that changes nothing under `loading()`

On a cold click, a route with `transition()` and `loading()` can start a view transition that changes nothing on screen, and its content shows only after that transition ends ([#1078](https://github.com/rangojs/rango/issues/1078)). React causes it, not a router update, and the router does not steer or cancel it. Two shapes hit it:

- **One loader slower than about 320 ms, on a navigation where the route's client component module is still loading when the navigation first renders.** In a production build that is the first navigation to that module; in dev it is every navigation, because the dev server resolves each response's client references asynchronously.
- **Two or more loaders under one `loading()` whose data lands at different times, the last one later than about 320 ms.** Module state does not matter.

Not affected: a fully prefetched click (it commits complete), and a loader that lands before the fallback has been up for 300 ms (the 100 ms and 280 ms cells in #1078 ran two view transitions, the navigation's and the reveal's).

The cost is the browser's view-transition duration before the content shows: Chromium's default animation is 250 ms, and the idle transitions measured took 265 to 285 ms from `ready` to `finished`. The View Transitions guide on the docs site ("When a view transition changes nothing") has the start counts and content times per shape, in dev and in production.

**Why.** When the first thing the route's `loading()` boundary waits on lands (the client module, or the first loader), React retries the boundary. The retry suspends again on the slower loader and commits with the fallback still in place, throttled to 300 ms after the fallback committed. That commit is view-transition eligible and the router's `<ViewTransition>` is on its path, so React calls `document.startViewTransition`; nothing changes on screen, the browser still runs its default animation, and the slower loader's reveal waits: React holds the next view-transition commit until the running transition's `finished` resolves. React 19.3.0 and the canary and experimental builds of 2026-10-06 behave the same.

### Escape hatches

Two options remove it, in dev and in production:

- **`transition({ viewTransition: false })`** places no router `<ViewTransition>` for the segment that declares it, so React has nothing of that segment's to animate on the retry commit. The navigation still commits through `startTransition`, so same-route content is still held; what you give up is the router's cross-fade. It only covers the segment it is set on: a layout above that declares its own `transition()` still wraps the route's outlet content in a router `<ViewTransition>` (`wrapDefaultOutletContent` in [segment-system.tsx](../../src/segment-system.tsx)), and the idle transition stays. Set it on every segment in the matched chain that declares `transition()`, or app-wide with `createRouter({ viewTransition: false })`.
- **`transition({ when })` returning `false`** commits the navigation urgently and renders every router `<ViewTransition>` of the navigation with every class `"none"` (`GATED_OFF_CLASSES` in [segment-system.tsx](../../src/segment-system.tsx)); React starts no transition for it. One `when` on one segment is enough, because a `false` gates the whole navigation off: on a same-route navigation the `loading()` skeleton streams instead of the previous content being held, and nothing animates. Use it when `kind`, `from` and `to` tell you which navigations hit the shape.

### Your own `<ViewTransition>`

A `<ViewTransition>` that you place and that stays on screen across the navigation (for example around a layout's `<Outlet />`) takes part in the same commits and starts the same idle transition, whichever router option is set. The router only controls its own boundaries, so this one is yours to configure. `update="none"` on it started no view transition for the click, but the boundary then no longer animates the real navigation's update either (no cross-fade of the outlet). Measured in Chromium only; other engines were not measured.

## Testing a transition() route

On React 19.3+ a transition commit briefly keeps the exiting `<ViewTransition>`
host in the DOM next to the entering one (hidden, carrying React's `vt-*`
attributes) for a few hundred milliseconds. A strict Playwright locator on a
test id that exists in both the old and the new view (same route, different
params; a hard load followed by a revalidation commit) resolves to two elements
during that window. Target the entering host, which is appended after the
exiting one:

```ts
const page$ = page.getByTestId("feature-page").last();
await expect(page$).toBeVisible();
```

Waiting for `toHaveCount(1)` first is not enough: the count passes through 1
before the second host is inserted.

Unit-test a `when` with `runTransitionWhen(when, { kind, from, to, action })`
from `@rangojs/router/testing`, and a route's hold with `renderRoute`:
`router.navigate()` decides with `kind: "push"`, `router.refresh()` with
`kind: "revalidate"`. Pop, action and `clientUrls()` optimistic-swap
decisions are e2e territory. See the testing skill, `predicates.md`.

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
