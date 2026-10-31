# Tree-Structure-Critical Files (DO NOT MODIFY without understanding)

The title isn't being dramatic. If you're about to touch segment rendering,
merging, or a wrapper component, read this first — the files below are the ones
where a small, innocent-looking change ripples into a class of bug that is genuinely
miserable to track down.

The following files control the React tree structure. Changing the tree structure
(element types, nesting depth, or keys at any position) between SSR, navigation,
and action renders will cause React to remount components, destroying client state
like `useActionState`, refs, and local state. This is extremely hard to debug.

## Protected files

- `src/segment-system.tsx` - `renderSegments()` builds the React tree from segments.
  The `loading` property determines tree structure:
  - `undefined` / `null` -> OutletProvider directly (no boundary). The walkers
    emit `loading(false)` as `null` (`router/segment-resolution/revalidation.ts`,
    `router/intercept-resolution.ts`, `router/prerender-match.ts`), so it renders
    here, as does a `loading(fallback, { ssr: false })` document.
  - `false` -> LoaderBoundary + OutletProvider (boundary, no RouteContentWrapper).
    `renderSegments` keeps this branch, but the server never sends `false`.
  - truthy (ReactNode) -> LoaderBoundary + OutletProvider + RouteContentWrapper
  - a `clientUrls()` group segment (`segment.clientGroup` set) -> ONE wrapper
    shape per group mount, with no LoaderBoundary/RouteContentWrapper
    (`ClientUrlsRoot` renders `loading()` itself); the server-side `loading`
    value still drives SSR (PPR masking is per loader, not per `loading` —
    see [`/ppr` → The loader lane rule](../skills/ppr/SKILL.md#the-loader-lane-rule))

  Segment `key` derivation (the per-segment `key` that flows into the
  LoaderBoundary/OutletProvider/Suspense keys), gated on `inTransitionScope`
  (computed once per render: does any layout, route, error, or notFound segment
  in the matched chain declare `transition()`):
  - `route` and route-owned (`belongsToRoute`) `layout` segments use a
    param-AGNOSTIC key (`id` only) WHEN `inTransitionScope`; otherwise they keep
    a param-BEARING key (`id-params`). The param-agnostic case is the
    transition() opt-in: navigating between two param values of the same route
    (e.g. `/product/1` -> `/product/2`) reconciles the route subtree instead of
    remounting it, so the previous content stays visible during the
    startTransition commit that `shouldStartViewTransition` already applies to
    transition routes (`src/browser/partial-update.ts`) instead of flashing the
    loading skeleton. On React 19.3+ the persistent `<ViewTransition>`
    then animates the same-route swap (morph) rather than exit/enter. Without a
    transition scope the route keeps the param and remounts on param change (the
    default).
  - `clientUrls()` group segments use ONE key per group mount
    (`cg:<clientGroup>`) regardless of route or params, so an in-group
    navigation reconciles the mounted `ClientUrlsRoot`: the optimistic
    destination keeps its instance across the canonical commit, and same-route
    param navigations hold instead of remounting. The param-bearing
    `id-params` value leads the `reset` of the segment's error boundary,
    followed by its loaders' data.
  - `error` / `notFound` segments ALWAYS keep a param-BEARING key (`id-params`).
    `createErrorSegment` reuses the boundary layout's shortCode as the error
    segment id (`src/router/error-handling.ts`), so a param-agnostic error key
    could collide with that layout's key in the same render.
  - For a given route, `inTransitionScope` is a STATIC property of its position
    in the tree (it has transition() or it doesn't), so the key is identical on
    SSR, navigation, and action renders — keys never drift. Do NOT make the
    param-agnostic decision depend on anything that varies per navigation (e.g.
    a from/to comparison): if one render path appended params and another did
    not, the keys would differ and React would remount.

- `src/route-content-wrapper.tsx` - `LoaderBoundary` and `RouteContentWrapper`.
  These add structural depth (Suspense boundaries) to the React tree.

- `src/browser/server-action-bridge.ts` - Merges server action segments with
  cached segments. Must preserve cached `loading` values to prevent tree drift.

- `src/browser/partial-update.ts` - Merges navigation segments with cached segments.

## Rules

1. Never change the conditional logic in `renderSegments()` that decides between
   LoaderBoundary/RouteContentWrapper/OutletProvider without verifying all three
   render paths (SSR, navigation, action) produce identical tree structures.
   `src/__tests__/tree/structure.test.tsx` pins the element types, depth and
   keys for each `loading` variant on SSR, navigation, back/forward and action
   renders.

2. Never add or remove wrapper elements (Suspense, div, Fragment) around segment
   content without checking that the same wrappers exist in ALL render paths.

3. When merging segments (action bridge, partial update), always preserve the
   cached `loading` value if it differs from the server value. The server may
   return different `loading` values based on `isSSR` context.

4. A loader entry is a wrapper too: a segment with loaders gets a
   `StreamedLoaderErrorBoundary` (`renderSegments`), so the loader segments a
   layout holds must not differ between render paths. A route's loaders
   inherited into a child layout with parallel slots are one such case:
   whether the copy is redundant is decided from the route entry, the same on
   every request (`inheritedCopyRedundant` in
   `router/segment-resolution/revalidation.ts`), never from a segment's
   `loading`, which is `null` on a `loading(fallback, { ssr: false })`
   document and the fallback on its partials. The walkers never resolve a
   redundant copy, on any request: dropping one later only beside the route's
   own copy sent it alone on an action or a same-route navigation that held
   the route's loader (its `revalidate()` declines), so the layout gained a
   loader entry and remounted.
   `src/testing/__tests__/inherited-loader-copy.rsc-test.tsx` pins it on the
   document, a navigation and an action, with and without the route's loader
   held.

5. Run `pnpm --filter @rangojs/router exec playwright test loader-behavior` after
   any changes to these files. The skipSSR tests (`loading(fallback, { ssr: false })`)
   specifically catch tree structure regressions. Changes that touch the
   client group key also need `e2e/client-urls.test.ts` (param-nav hold and the
   optimistic destination) in dev and production.
