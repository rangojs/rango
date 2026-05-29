---
name: view-transitions
description: Configure React View Transitions on layouts, routes, and parallel slots in @rangojs/router
argument-hint: [layout|route|parallel|intercept]
---

# View Transitions

Rango wires React's experimental `<ViewTransition>` into the segment tree via the `transition()` helper. Each segment can declare its own transition config; rango wraps it at the right tree position so navigations morph the right pieces and modals do not.

> Requires React experimental (the build that exports `<ViewTransition>` and `addTransitionType`). With stable React, `transition()` is a no-op — your routes still render, just without view-transition wrappers.

## What `transition()` does

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
}
```

- `default` is the catch-all if a phase-specific prop is unset.
- The object form keys are React transition types tagged by rango: `"navigation"` (forward navigations), `"navigation-back"` (popstate cache restores), and `"action"` (partial-update action/refetch paths only — see the caveat in "Direction-aware transitions").
- `name` lets you participate in cross-page morphs by name (advanced; you usually don't need this on a layout/route-level wrap).

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
