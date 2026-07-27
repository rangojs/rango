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

Pending:

- [ ] `useRouter().push` mount-awareness — UNDER CONSIDERATION, decision needed
- [ ] `useLocationState` write path — UNDER CONSIDERATION, decision needed
- [ ] `useReverse` local form — OPEN, decision needed
- [ ] `useRefreshLoaders` — OPEN, needs a pin or documented contract
- [ ] `useAction` lifecycle in groups — OPEN, needs a pin
- [ ] `useParams` optimistic-window semantics — OPEN, confirm as by-design
- [ ] `useTheme` under a group — OPEN, confirm orthogonal or pin
- [ ] Prefetch tiers inside groups — OPEN, promote demo coverage into the router suite or accept demo-only
- [ ] Search reads in ppr STATIC parts — OPEN, enforce capture-time postpone or accept the documented rule

## Settled / pinned

The working set. Semantics stated in `docs/client-urls.md` § "Client hooks
inside a group"; pins named per row.

| Hook                              | The group semantics                                                                                                                                                                                                                                                                                    | Pinned by                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `useOutlet`                       | Group-layout `pending` is ANY in-flight group intent (same-route included); leaf routes read the enclosing SERVER outlet, where `pending` means something else                                                                                                                                         | `client-urls.test.ts` soft-nav + `client-shop-filters.test.ts` aria-busy        |
| `useLoader`                       | Reads the group's own projected loaders (stubs by `$$id`); implicit suspension to the inline boundary                                                                                                                                                                                                  | action-reval, transition, stream suites                                         |
| `useParams`                       | The SERVER route match (materialized `path()` per group route) — agrees with the group's local match because the patterns are identical                                                                                                                                                                | hard-load + param-nav tests both apps                                           |
| `useHandle` (read)                | Read-only in groups; writes come from loaders (`ctx.use(Meta)`), no `handle()` DSL item                                                                                                                                                                                                                | `client-shop-handles.test.ts`                                                   |
| `useSearchParams`                 | Tuple; reader carries REAL values during document SSR (live request seeds the SSR store via SSRRenderOptions.search; browser seeds from its own URL — hydration agrees; asserted in RAW HTML). Exception: ppr capture/resume stays search-agnostic. Setter is a same-route write with the content-hold | hook probe "SSR search values, setter write"                                    |
| `Link`                            | Absolute `to=` only — the mount is hand-composed or built with `useHref`                                                                                                                                                                                                                               | every clientUrls suite                                                          |
| `useHref` / `href()`              | THE way to build group-local links; composes the include mount (`groupHref("/")` = trailing-slash bare mount)                                                                                                                                                                                          | hook probe "useHref composes the include mount"                                 |
| `useMount`                        | The include mount, load-bearing internally (`ClientUrlsRoot`) and legal in userland                                                                                                                                                                                                                    | hook probe                                                                      |
| `usePathname`                     | ABSOLUTE, mount included — never compare against definition-local `path()` patterns                                                                                                                                                                                                                    | hook probe                                                                      |
| `useNavigation` / `useLinkStatus` | Fire for group navs from the global pendingUrl. Placement rule: a reader inside optimistically-swapped content (destination WITH `loading()`) unmounts at click — put status readers in chrome that survives                                                                                           | hook probe "useLinkStatus and useNavigation report a group nav" (request-gated) |
| `useFetchLoader`                  | Route-independent lane (`createLoader(fn, fetchable: true)`, addressed by id) — works unchanged; `revalidate()` deliberately NOT consulted (imperative `load()` = explicit freshness). Maintainer settled 2026-07-27                                                                                   | hook probe "useFetchLoader fetches by loader id"                                |
| `ErrorBoundary`                   | The in-group error affordance (no `errorBoundary()` DSL by design); render throw contained, group chrome intact                                                                                                                                                                                        | hook probe "plain React ErrorBoundary"                                          |
| `useNonce`                        | SSR-only value, identical in and out of groups                                                                                                                                                                                                                                                         | none needed                                                                     |

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

### `useRouter().push()` mount-awareness

Today `withBasename` (`browser/react/use-router.ts`) composes the app
basename but NOT the include mount, so `push("/items/x")` from inside a
group mounted at `/shop` navigates to `/items/x` — outside the group,
silently.

Hard constraint for any fix: **absolute paths must stay app-absolute.**
Basename can be auto-prefixed because it is app-global — every absolute path
in the app lives under it. The mount is scoped: the same component can be
mounted at different prefixes, and absolute paths legitimately target
OUTSIDE the mount (cross-group links do this today). Auto-prefixing
`push("/x")` would silently re-target every existing absolute push inside
mounted subtrees.

Candidate designs:

1. **Relative-path resolution (recommended).** Non-slash paths resolve
   against the mount: `push("cart")` inside `include("/shop")` →
   `/shop/cart`; `push("/cart")` stays `/cart`. Additive — non-slash paths
   are currently undefined behavior. `useRouter` would capture
   `useMount()`; the returned object stays stable per component.
2. **Composition only (today's answer, documented).**
   `router.push(groupHref("/cart"))` — zero new API, already pinned.

Settles when: a decision is recorded here; option 1 additionally needs
implementation + hook-probe pins (in-group relative push, absolute push
unchanged) + docs.

### `useLocationState` write path in groups

Read side already works (reads `history.state` directly). The server write
is `ctx.setLocationState` — needs a handler, and groups have none — so only
`<Link state={...}>` reaches it from a group today.

Candidate designs:

1. **Client-side setter (lean recommendation).** A browser-only write
   (`history.replaceState`-based, mirroring the flash-state machinery in
   `browser/react/location-state.ts`). No projection concerns, works
   everywhere, groups included.
2. **Loader writes.** The only server code groups have — but location state
   is a navigation concern; a data loader writing navigation state is a
   shape mismatch.
3. **Link-state only, documented.** Accept the current reach and state it.

Settles when: a decision is recorded; option 1/2 need design + red-proven
coverage; option 3 needs a docs line promoting the caveat to a contract.

## Open

### `useReverse` local (mount-aware) form

The per-module gen writer (`build/route-types/per-module-writer.ts`) keys
off NAMED `urls`/`clientUrls` variables; every clientUrls fixture and the
documented shape use `export default clientUrls(...)` — so no
`client-urls*.gen.ts` is ever emitted and the mount-aware local form has no
route map to consume. Group route names DO reach the global map when the
include is named, so global `href()`/`reverse()` work.

Options: teach the writer to emit for default-exported clientUrls modules;
or declare the local form global-map-only for groups and document it.
Settles with a decision + (if fixed) writer change + typegen test + probe
pin.

### `useRefreshLoaders`

Issues a plain GET against the current URL to refresh mounted reads by
group tag. Inside a clientUrls group that GET re-evaluates held loaders
under SERVER defaults — the client `revalidate()` decision header is not
attached by this lane. Probably correct (an explicit refresh wants
freshness, mirroring the `useFetchLoader` settlement), but it is unpinned.
Settles with: one hook-probe test tagging a group loader with
`refreshGroup` and asserting the refresh, plus a docs line stating the
predicate-bypass is deliberate.

### `useAction` lifecycle inside groups

The action PATH is settled (decisions ride the POST —
`client-urls.test.ts` action-revalidation test), but no fixture reads
`useAction` state inside a group, and its `useOptimistic` pinning vs the
group's transition-wrapped intent `clear()` is unexercised composition.
Settles with: an action button in the hook probe driven through
`useAction`, asserting pending state during the gated POST and settled
state after.

### `useParams` during the optimistic window

While a destination `loading()` presents optimistically, the store still
holds ORIGIN params (`useParams` reads the committed match). Consistent
with the committed-location model (`useSearchParams` behaves the same), but
nothing states it. Settles with: confirm as by-design here + one docs
sentence; or a pin if we want it frozen.

### `useTheme` under a group

Separate `./theme` entry, provider sits above the router tree, so groups
inherit it like any client component. Expected orthogonal; unverified.
Settles with: confirm orthogonal here (no pin needed) or a one-line probe
assertion if we want it in the matrix.

### Search reads in ppr static parts (enforcement)

With SSR now seeding real search on the live-fizz path, the one
search-agnostic lane is the ppr shell capture/resume pair — resume requires
the tree above the holes to match the captured tree, so both render with an
empty-search store. A ppr STATIC part that derives markup from
`useSearchParams` therefore renders its empty branch in the shell and
hydration-mismatches against the browser's real-URL seed. Documented as a
rule ("read search in a live hole"); NOT yet enforced. Settles with either:
capture-time postpone on search reads (the Next-style dynamic bailout — the
read escapes into a hole automatically), or an accepted documented-rule
status recorded here.

### Prefetch tiers inside groups

The router's own clientUrls suites use `prefetch="none"` everywhere; the
DEMO exercises `viewport` (grid cards) and `hover` (related products)
inside the group and the instant warmed-click PDP path is measured there
(`client-shop` suites). Settles with: either accept demo coverage as the
pin (record that here) or add a prefetch tier to the router-suite probe.
