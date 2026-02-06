# @rangojs/router

Run `/rango` first to understand the API. Skills are in `node_modules/@rangojs/router/skills/`.

## Tree-Structure-Critical Files (DO NOT MODIFY without understanding)

The following files control the React tree structure. Changing the tree structure
(element types, nesting depth, or keys at any position) between SSR, navigation,
and action renders will cause React to remount components, destroying client state
like `useActionState`, refs, and local state. This is extremely hard to debug.

**Protected files:**

- `src/segment-system.tsx` - `renderSegments()` builds the React tree from segments.
  The `loading` property determines tree structure:
  - `undefined` / `null` -> OutletProvider directly (no boundary)
  - `false` -> LoaderBoundary + OutletProvider (boundary, no RouteContentWrapper)
  - truthy (ReactNode) -> LoaderBoundary + OutletProvider + RouteContentWrapper

- `src/route-content-wrapper.tsx` - `LoaderBoundary` and `RouteContentWrapper`.
  These add structural depth (Suspense boundaries) to the React tree.

- `src/browser/server-action-bridge.ts` - Merges server action segments with
  cached segments. Must preserve cached `loading` values to prevent tree drift.

- `src/browser/partial-update.ts` - Merges navigation segments with cached segments.

**Rules:**

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
