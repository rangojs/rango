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
  - `undefined` / `null` -> OutletProvider directly (no boundary)
  - `false` -> LoaderBoundary + OutletProvider (boundary, no RouteContentWrapper)
  - truthy (ReactNode) -> LoaderBoundary + OutletProvider + RouteContentWrapper

  Segment `key` derivation (the per-segment `key` that flows into the
  LoaderBoundary/OutletProvider/Suspense keys), gated on `inTransitionScope`
  (computed once per render: does any layout/route segment in the matched chain
  declare `transition()`):
  - `route` and route-owned (`belongsToRoute`) `layout` segments use a
    param-AGNOSTIC key (`id` only) WHEN `inTransitionScope`; otherwise they keep
    a param-BEARING key (`id-params`). The param-agnostic case is the
    transition() opt-in: navigating between two param values of the same route
    (e.g. `/product/1` -> `/product/2`) reconciles the route subtree instead of
    remounting it, so the previous content stays visible during the
    startTransition commit that `shouldStartViewTransition` already applies to
    transition routes (`browser/partial-update.ts`) instead of flashing the
    loading skeleton. On experimental React the persistent `<ViewTransition>`
    then animates the same-route swap (morph) rather than exit/enter. Without a
    transition scope the route keeps the param and remounts on param change (the
    default).
  - `error` / `notFound` segments ALWAYS keep a param-BEARING key (`id-params`).
    `createErrorSegment` reuses the boundary layout's shortCode as the error
    segment id (`router/error-handling.ts`), so a param-agnostic error key
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

2. Never add or remove wrapper elements (Suspense, div, Fragment) around segment
   content without checking that the same wrappers exist in ALL render paths.

3. When merging segments (action bridge, partial update), always preserve the
   cached `loading` value if it differs from the server value. The server may
   return different `loading` values based on `isSSR` context.

4. Run `pnpm --filter @rangojs/router exec playwright test loader-behavior` after
   any changes to these files. The skipSSR action tests specifically catch tree
   structure regressions.
