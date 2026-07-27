# clientUrls × client hooks — settlement review

This is the tracking document for the full `@rangojs/router/client` surface
against the clientUrls() group model. The rule for this review: **we are not
complete until every row is settled.** A row settles one of three ways — it
is supported and PINNED (fixture + dev/prod e2e), it is declared NOT
SUPPORTED with the structural reason documented, or a design decision is
recorded and implemented. Nothing gets to stay "probably fine."

How to read the statuses:

- **SETTLED / PINNED** — works in groups, asserted in both modes, docs state
  the semantics. Nothing to do.
- **SETTLED / NOT IN GROUPS** — structurally out, documented in
  `docs/client-urls.md` ("Client hooks inside a group"). Re-open only with
  new information.
- **UNDER CONSIDERATION** — maintainer has flagged it for possible support;
  design options recorded below, decision pending.
- **OPEN** — not yet decided or not yet covered; each carries the concrete
  action that settles it.

The evidence anchors: hook probe fixture
`e2e/test-app/src/urls/client-urls.tsx` (`ClientUrlsHooksProbe`), suite
`e2e/client-urls.test.ts` ("hook probe" tests, shared spec = dev+prod),
demo `tests/vite-rsc-demo/src/urls/client-shop.client.tsx` with the
`client-shop-*.test.ts` suites.

## Checklist

Settled:

- [x] `useOutlet` — pinned
- [x] `useLoader` — pinned
- [x] `useParams` — pinned (one confirm below)
- [x] `useHandle` (read) / `Meta` / `Breadcrumbs` — pinned
- [x] `useSearchParams` (tuple read + setter) — pinned incl. SSR REAL-VALUES raw-HTML pin (decision 2026-07-27: the live request seeds the SSR store)
- [x] `Link` — pinned
- [x] `useHref` / `href()` — pinned
- [x] `useMount` — pinned
- [x] `usePathname` — pinned as ABSOLUTE
- [x] `useNavigation` / `useLinkStatus` — pinned + placement rule
- [x] `useFetchLoader` — pinned (maintainer decision 2026-07-27)
- [x] `ErrorBoundary` — pinned as the in-group idiom
- [x] `ParallelOutlet` — NOT in groups (documented)
- [x] `useSegments` — NOT meaningful in groups (documented)
- [x] `ScrollRestoration` / `MetaTags` / `Scripts` / `NavigationProvider` — root-level, not group APIs (documented)
- [x] `useNonce` — orthogonal (SSR-only value, no group interaction)

Settled 2026-07-27 (second batch):

- [x] `useRouter().push` mount-awareness — DECIDED + SHIPPED: relative paths resolve against the mount (absolute stays app-absolute, never auto-prefixed); pinned by hook probe "relative router.push resolves against the include mount"
- [x] `useRefreshLoaders` — pinned ("re-runs a group-tagged read"); the refresh lane IS the fetch lane, so tagged loaders must be `fetchable: true`; `revalidate()` deliberately not consulted (same settlement as `useFetchLoader`)
- [x] `useAction` lifecycle — pinned ("tracks a group action's lifecycle": idle → loading under a gated POST → idle)
- [x] `useParams` optimistic-window — CONFIRMED by-design: committed-match model (origin params during the optimistic window, like `useSearchParams`); documented in client-urls.md
- [x] `useTheme` — CONFIRMED orthogonal: separate `./theme` entry, provider sits above the router tree, groups inherit it like any client component; no pin needed
- [x] Prefetch tiers inside groups — SETTLED as demo-pinned: `client-shop` exercises `viewport` (grid cards) and `hover` (related) inside the group with the warmed-click PDP path measured; accepted as the pin

Settled 2026-07-27 (third batch):

- [x] `useLocationState` write path — DECIDED + SHIPPED: the group write
      surface is action writes (in-place merge on settle) + redirect-carried
      state (action AND loader redirects); loader redirect state now rides
      the loader-result marker (was silently dropped); no dedicated client
      setter added. Pinned by three hook probes, dev+prod.
- [x] `useReverse` local form — SETTLED: the original row was STALE — the
      writer already handles default-exported clientUrls modules (unit-pinned
      in `client-urls-route-types.test.ts`). The real gap was a `rango
generate` CLI classify bug ("clientUrls(" has a capital U, so the
      lowercase `urls(` sniff skipped group modules) — fixed, red-proven.
      Pinned by hook probe "useReverse local form composes the include
      mount", dev+prod.
- [x] Search reads in ppr STATIC parts — SETTLED by SEEDING, not
      enforcement: search is part of shell identity (the key already embeds
      the sorted filtered search), so the capture/resume renders now seed
      the key's own search (`shellSearchSeed`) and static-part reads are
      LEGAL. Pinned by the shell-cache probe, dev+prod, red-proven.

Pending: none — every row is settled.

## Settled / pinned

The working set. Semantics stated in `docs/client-urls.md` § "Client hooks
inside a group"; pins named per row.

| Hook                              | The group semantics                                                                                                                                                                                                                                                                                                                                                   | Pinned by                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `useOutlet`                       | Group-layout `pending` is ANY in-flight group intent (same-route included); leaf routes read the enclosing SERVER outlet, where `pending` means something else                                                                                                                                                                                                        | `client-urls.test.ts` soft-nav + `client-shop-filters.test.ts` aria-busy                           |
| `useLoader`                       | Reads the group's own projected loaders (stubs by `$$id`); implicit suspension to the inline boundary                                                                                                                                                                                                                                                                 | action-reval, transition, stream suites                                                            |
| `useParams`                       | The SERVER route match (materialized `path()` per group route) — agrees with the group's local match because the patterns are identical                                                                                                                                                                                                                               | hard-load + param-nav tests both apps                                                              |
| `useHandle` (read)                | Read-only in groups; writes come from loaders (`ctx.use(Meta)`), no `handle()` DSL item                                                                                                                                                                                                                                                                               | `client-shop-handles.test.ts`                                                                      |
| `useSearchParams`                 | Tuple; reader carries REAL values during document SSR (live request seeds the SSR store via SSRRenderOptions.search; browser seeds from its own URL — hydration agrees; asserted in RAW HTML). Ppr routes: capture/resume seed the SHELL KEY's sorted search (search is shell identity) — static-part reads legal. Setter is a same-route write with the content-hold | hook probe "SSR search values, setter write"                                                       |
| `Link`                            | Absolute `to=` only — the mount is hand-composed or built with `useHref`                                                                                                                                                                                                                                                                                              | every clientUrls suite                                                                             |
| `useHref` / `href()`              | THE way to build group-local links; composes the include mount (`groupHref("/")` = trailing-slash bare mount)                                                                                                                                                                                                                                                         | hook probe "useHref composes the include mount"                                                    |
| `useMount`                        | The include mount, load-bearing internally (`ClientUrlsRoot`) and legal in userland                                                                                                                                                                                                                                                                                   | hook probe                                                                                         |
| `usePathname`                     | ABSOLUTE, mount included — never compare against definition-local `path()` patterns                                                                                                                                                                                                                                                                                   | hook probe                                                                                         |
| `useNavigation` / `useLinkStatus` | Fire for group navs from the global pendingUrl. Placement rule: a reader inside optimistically-swapped content (destination WITH `loading()`) unmounts at click — put status readers in chrome that survives                                                                                                                                                          | hook probe "useLinkStatus and useNavigation report a group nav" (request-gated)                    |
| `useFetchLoader`                  | Route-independent lane (`createLoader(fn, fetchable: true)`, addressed by id) — works unchanged; `revalidate()` deliberately NOT consulted (imperative `load()` = explicit freshness). Maintainer settled 2026-07-27                                                                                                                                                  | hook probe "useFetchLoader fetches by loader id"                                                   |
| `ErrorBoundary`                   | The in-group error affordance (no `errorBoundary()` DSL by design); render throw contained, group chrome intact                                                                                                                                                                                                                                                       | hook probe "plain React ErrorBoundary"                                                             |
| `useNonce`                        | SSR-only value, identical in and out of groups                                                                                                                                                                                                                                                                                                                        | none needed                                                                                        |
| `useLocationState`                | Reads work anywhere (history.state). Group writes are the in-place lanes: `<Link state>`, action writes (merge on settle), and `redirect(url, { state })` from actions AND group loaders (loader state rides the result marker, delivered with the redirect nav — the metadata lane misses post-flush)                                                                | hook probes "writes location state in place", "action redirect", "loader redirect" + envelope unit |
| `useReverse` (local form)         | Name group routes and the per-module writer emits the sibling gen map for the default-exported module; `useReverse(routes)` composes the include mount, `/` collapses to the bare mount; names stay local under an unnamed include (CLI classify bug fixed — capital U in "clientUrls(")                                                                              | hook probe "useReverse local form composes the include mount" + CLI classify test                  |

## Settled / not in groups

Structural, not missing wiring. Documented in `docs/client-urls.md`.

- **`ParallelOutlet`** — `ClientUrlsRoot` builds its `OutletProvider`s with
  `{content, pending}` only (`client-urls/client-root.tsx`); no
  `parallel`/`segment` ever flows to a userland group layout. Slots exist
  solely in the server-materialized `ClientUrlsGroupLayout` (intercept
  presentation). Consistent with parallel being out of the DSL
  (minimal-surface decision, `project_clienturls_no_dsl_boundaries`).
- **`useSegments`** — segment ids are SERVER segments and the whole group is
  one route segment; the group's own `route.layouts` nesting is invisible.
  Its answer inside a group does not describe the group. `path` (URL split)
  still works, but that is `usePathname` territory.
- **`ScrollRestoration` / `useScrollRestoration`** — module singleton,
  documented "render once in your root layout"; mounting in a group tears
  down stored positions on group unmount.
- **`MetaTags` / `Scripts` / `NavigationProvider`** — document-head / app-root
  components; nothing group-specific to support.

## Under consideration (maintainer-flagged 2026-07-27)

### `useRouter().push()` mount-awareness — SETTLED 2026-07-27

Decision: relative-path resolution (option 1), shipped. `resolveTarget` in
`browser/react/use-router.ts`: a path starting with a word character (or
`./`), never a scheme/query/hash form, joins onto `useMount()` and then
takes the basename pass; push, replace, and prefetch all resolve. Absolute
paths stay APP-absolute — the hard constraint held: the mount is scoped
(unlike basename) and absolute pushes legitimately target outside it, so
they are never auto-prefixed. Pinned by the hook probe ("relative
router.push resolves against the include mount", dev+prod).

### `useLocationState` write path in groups — SETTLED 2026-07-27

Decision: the write model is **commit-coupled vs in-place**, and groups get
the in-place lanes. A navigation-handler `ctx.setLocationState` is
commit-coupled (arrives with the nav via payload metadata, stamps the
incoming entry) — unreachable from groups and left as-is app-wide. The
group-reachable writes are all in-place/with-the-nav:

- **Action writes** — `getRequestContext().setLocationState(...)` in a
  server action merges into the CURRENT entry on settle (the existing
  action-lane arbitration applies unchanged in groups).
- **Action redirects** — `redirect(url, { state })` delivers via the
  redirect Flight metadata, exactly as outside groups.
- **Loader redirects** — `redirect(url, { state })` thrown from a group
  loader. This lane was BROKEN (red-proven): a streaming loader settles
  after `attachLocationStateIfPresent` stamped payload metadata
  (`rsc-rendering.ts`), so the state missed the payload, and the
  loader-result marker carried only `{ to }` — `LoaderRedirect` navigated
  stateless. Fix: `redirect()` brands the thrown Response with the resolved
  record (`attachRedirectState`, `redirect-origin.ts`); the envelope ships
  `redirect: { to, state }` (`loader-resolution.ts`); `LoaderRedirect`
  navigates with `{ state, _skipCache: true }` — the ServerRedirect
  application path, merging at the TARGET entry.

None of the original candidates was taken as written: no dedicated
client-side setter shipped (option 1 stays available if demand appears —
the maintainer accepted async in-place delivery as the model), loaders do
not write navigation state outside the redirect shape (option 2's
mismatch), and the reach is wider than option 3's link-only.

Pinned by three hook probes (dev+prod): "a group action writes location
state in place", "an action redirect delivers flash state into the group",
"a loader redirect carries its location state to the target"; envelope unit
in `loader-signal-envelopes.test.ts` (red-proven without the
loader-resolution change).

## Open

### `useReverse` local (mount-aware) form — SETTLED 2026-07-27

The original row was STALE: the per-module writer already handles
default-exported clientUrls modules — `writePerModuleRouteTypesForFile`
falls back to direct named-path extraction when no `const X = urls(...)`
variable exists, and `buildCombinedRouteMapWithSearch(path, "default")`
resolves inline default exports; both were unit-pinned in
`client-urls-route-types.test.ts` before this review. (Guard against this:
the "Don't overstate findings" rule — the row was written without checking
those tests.)

The REAL gap was one classify sniff: `rango generate` gated urls files on
`source.includes("urls(")`, and `"clientUrls("` does not contain that
token — the U is capital — so the CLI silently skipped clientUrls-only
modules (the writer's own gate at `per-module-writer.ts:74` checks both
spellings, which is why direct calls and the vite discovery lane worked;
`router-discovery.ts` even documents this exact sub-identifier trap).
Fixed at both bin sites (`src/bin/rango.ts`), red-proven by the spawned-CLI
test "classifies a clientUrls-only module".

Pinned end-to-end: named routes in the hook-probe fixture emit
`client-urls.gen.ts`, and `useReverse(routes)` composes the include mount
("useReverse local form composes the include mount", dev+prod — including
the `/`-index collapse to the bare mount). Names stay LOCAL under the
unnamed include: the run confirmed zero drift in any
`router.named-routes.gen.ts`.

### `useRefreshLoaders` — SETTLED 2026-07-27

Pinned ("hook probe: useRefreshLoaders re-runs a group-tagged read"). Two
recorded facts: the refresh lane IS the fetch lane (`LoaderStore` refetch =
`load()`), so tagged loaders must be `createLoader(fn, fetchable: true)` —
a non-fetchable member rejects `refreshGroups()` with an AggregateError, in
and out of groups alike; and `revalidate()` predicates are deliberately not
consulted (explicit refresh = explicit freshness, the `useFetchLoader`
settlement applied).

### `useAction` lifecycle inside groups — SETTLED 2026-07-27

Pinned ("hook probe: useAction tracks a group action's lifecycle"): idle →
loading while the action POST is gated → idle after it settles, inside the
group, both modes.

### `useParams` during the optimistic window — SETTLED 2026-07-27

Confirmed by-design: the committed-match model. During the optimistic
window `useParams` holds ORIGIN params, like `useSearchParams`;
destination params arrive with the canonical commit. Stated in
`docs/client-urls.md`.

### `useTheme` — SETTLED 2026-07-27

Confirmed orthogonal: separate `./theme` entry, provider above the router
tree, groups inherit it like any client component. No pin.

### Search reads in ppr static parts — SETTLED 2026-07-27

Resolved by making the render match the KEY, not by enforcement. The
premise behind the old rule ("the shell is shared across query strings, so
static parts must not read search") was wrong for the default config: the
shell key already embeds the sorted, `cache.searchParams`-filtered search
(`buildShellKey`, `shell-serve.ts`), so distinct query strings were already
distinct shells — the capture render was just blind to the search its own
key named, baking the empty branch into a per-search shell. The replay
constraint never forced blindness either: it only requires capture and
resume to AGREE, and a HIT shares the capture's key.

Shipped (maintainer direction: "make it key as we do with other pprs"):
`shellSearchSeed(url, filter)` — the key's own search portion, factored out
of `buildShellKey` so seed and key cannot drift — now seeds BOTH the
capture render (`ShellCaptureDescriptor.searchSeed` →
`ShellCaptureOptions.search`) and the resume render
(`ShellResumeOptions.search`, derived from the HIT request). Static-part
`useSearchParams` reads are legal: they bake what the key names, and HIT
hydration agrees with the browser URL. An earlier capture-time-throw guard
(PprCaptureSearchReadError) was built and then discarded in review — it
outlawed something the keying model had already paid for.

Documented edges (use-search-params.ts doc + client-urls.md): a param
EXCLUDED by `cache.searchParams` is absent in shell renders (exclusion
declares "does not affect markup"; reading one anyway hydration-mismatches
on shared shells), and `.toString()` renders sorted order while the browser
holds the raw URL order. Build-time shells stay bare-pathname
(search-less requests only), unchanged.

Pinned by "static-part useSearchParams bakes the key's search into its
shell; distinct search = distinct shell" (shell-cache.test.ts, dev+prod;
red-proven — without the seeding the prelude baked `filter:none`) and the
`shellSearchSeed` units (key/seed shared derivation).

### Prefetch tiers inside groups — SETTLED 2026-07-27

Demo coverage accepted as the pin: `client-shop` exercises `viewport`
(grid cards) and `hover` (related products) inside the group; the
warmed-click PDP path is measured in its suites.
