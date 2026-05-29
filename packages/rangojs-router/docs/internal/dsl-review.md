# Routes DSL — Code-Quality Review

Status: Proposal (no code changed). Date: 2026-05-29.

Scope: the Routes DSL "handling" layer — the code a consumer writes to define
routes and the engine that compiles it into the internal route tree. Reviewed
source (the package is consumed as raw TS, so this is `src/`, not `dist/`):

- Core helper engine — `src/route-definition/dsl-helpers.ts` (~1134 lines),
  `helper-factories.ts`, `resolve-handler-use.ts`, `route-definition/index.ts`,
  `redirect.ts`
- `urls()` / `path()` / `include()` — `src/urls/urls-function.ts`,
  `path-helper.ts`, `include-helper.ts`, `response-types.ts`, `pattern-types.ts`,
  `urls/index.ts`
- Internal tree model — `src/server/context.ts` (~740 lines): `EntryData`,
  `HelperContext`, the `getContext()` store API
- Type-level DSL — `helpers-types.ts`, `route-types.ts`, `path-helper-types.ts`,
  `type-extraction.ts`

Method: nine parallel readers (one per layer + cross-cutting passes for
duplication, concept, naming/style, and consumer ergonomics) produced 64 raw
findings; these were deduplicated to 42 and each was **adversarially verified**
against the router's documented invariants before being accepted, downgraded, or
rejected. Where a proposal would have broken something, the verifier's corrected
("safe") form is what this document records — the original, naive form is called
out in the [Traps](#appendix-traps--do-not) appendix.

This is a **readability / simplification** review, not a bug hunt. The router
works; the goal is to make the DSL engine easier to read and reason about, and to
name the concepts it currently leaves implicit.

### Invariants every refactor below must preserve

These are the contracts that make several "obvious" simplifications unsafe. They
are cited per-finding in the risk column.

- **Semantic matrix** (`e2e/semantic-matrix.test.ts`): middleware scope,
  handler-first ordering, context visibility, PE/JS parity.
- **Tree-structure rules** (`docs/tree-structure.md`): segment
  rendering/merging/wrapper components.
- **Orphan `entry.parent = null` clearing** is load-bearing
  (`docs/route-definition-rules.md`): it removes a wrapper entry from the
  parent-pointer / middleware chain so it is not double-processed.
- **`handler.use` merge order**: handler defaults first, explicit `use()` second.
- **shortCode / segment-id strings are wire-stable**: they appear in URLs and
  segment IDs and drive client/server reconciliation and
  `router.named-routes.gen.ts`. Changing their text is a behavior change.
- **Pre-release API hygiene**: no deprecated public API in `main`; remove
  transitional code rather than deprecate. Skills and examples count as API
  surface.

---

## How the DSL works today (the map)

A consumer writes a builder — `urls(({ path, layout, loader }) => [...])` (or the
older `map(...)`) — and each helper inside it is a function that **mutates an
AsyncLocalStorage-backed `HelperContext` as a side effect**. The shared pattern
in every helper is:

1. Fetch the store via `getContext().getStore()` and assert we are inside a
   builder.
2. Read `ctx.parent` — the entry currently being built.
3. Either **push directly** onto one of the parent's arrays (config helpers:
   `revalidate`/`errorBoundary`/`loading`/sibling `middleware`), or **build a
   fresh `EntryData` literal** (~14 fields, most empty `[]`/`{}`) and run its
   children via `store.run(namespace, entry, fn)`, which re-enters ALS with the
   new entry as parent.
4. Normalize the children result with `.flat(3)` and validate it with an
   `invariant` against `isValidUseItem`.
5. Structural helpers (`layout`/`cache`/`middleware`/`transition`) additionally
   detect the **orphan** case (no routes among children), clear
   `entry.parent = null`, and push the entry into `parent.layout` so it renders
   as a wrapper without joining the parent-pointer chain.
6. `intercept()` and `loader()` swap `ctx.parent` for a throwaway **`tempParent`**
   so nested helpers attach to a satellite entry, then (intercept) lift captured
   layouts back out.

`EntryData` (in `context.ts`) is a 4-arm discriminated union (`route` | `layout` |
`parallel` | `cache`) built from mixins, plus two satellite record types
(`LoaderEntry`, `InterceptEntry`). The `getContext()` store API exposes
`getNextIndex` (per-type `$type.N` counters), `getShortCode` (wire-visible codes
like `L0`, `R2`, `M1R0`), and two scope-runners (`run` / `runWithStore`).

`urls()` mirrors `map()`: it builds the same helper bundle plus `path()` /
`include()`, and `path()` re-implements `route()`'s entry-construction and
use-merge logic by hand rather than sharing it. **The single biggest conceptual
observation of this review is that `map()` and `urls()` are one engine with two
different leaf helpers — but the engine is currently copy-pasted, not shared.**

---

## Findings index

Verdict legend: **C** = confirmed safe as-is · **Q** = real issue, adopt the
_adjusted_ form noted (the naive form has a trap) · **R** = rejected.

| ID                                                           | Theme   | Sev  | Verdict | Effort | Primary file                                                   |
| ------------------------------------------------------------ | ------- | ---- | ------- | ------ | -------------------------------------------------------------- |
| [A1](#a1-context-guard) Context guard                        | dup     | High | C       | M      | dsl-helpers.ts                                                 |
| [A2](#a2-entrydata-literal) `EntryData` literal factory      | dup     | High | Q       | M      | dsl-helpers.ts                                                 |
| [A3](#a3-run-flat-validate) run+flat+validate block          | dup     | Med  | Q       | S      | dsl-helpers.ts                                                 |
| [A4](#a4-orphan-registration) Orphan registration            | dup     | High | Q       | M      | dsl-helpers.ts                                                 |
| [A5](#a5-use-item-vocabulary) Use-item vocabulary (4 copies) | dup     | High | C       | M      | dsl-helpers / path-helper / resolve-handler-use                |
| [A6](#a6-arg-disambiguation) Overloaded-arg disambiguation   | flow    | Med  | Q       | M      | dsl-helpers.ts                                                 |
| [A7](#a7-shortcode) `getShortCode` ternary + counter-bump    | flow    | Med  | C       | S      | context.ts                                                     |
| [A8](#a8-url-prefix) URL-prefix join (4 copies)              | dup     | Med  | Q       | S      | path-helper / include-helper / context.ts                      |
| [A9](#a9-shared-engine) `path()` rebuilds `route()`'s engine | dup     | High | Q       | M      | path-helper.ts                                                 |
| [A10](#a10-tempparent) `tempParent` retargeting              | concept | High | Q       | M      | dsl-helpers.ts                                                 |
| [B1](#b1-dead-pathdefinition) Dead `PathDefinition` API      | dead    | Med  | C       | S      | urls-function.ts                                               |
| [B2](#b2-dead-extract-stubs) Unimplemented `Extract*` stubs  | dead    | Med  | C       | S      | type-extraction.ts                                             |
| [B3](#b3-inert-depth) Inert `Depth`/`Simplify`               | dead    | High | C       | S      | type-extraction.ts                                             |
| [B4](#b4-dead-eager-include) Dead eager-include path         | dead    | Med  | C       | S      | include-helper.ts                                              |
| [B5](#b5-dead-brands) 14 dead phantom brand fields           | dead    | Med  | C       | M      | route-types.ts                                                 |
| [B6](#b6-run-divergence) `run` vs `runWithStore` divergence  | dup     | High | Q       | M      | context.ts                                                     |
| [C1](#c1-fn-suffix) `*Fn` naming + export blocks             | name    | Med  | Q       | S      | dsl-helpers.ts                                                 |
| [C2](#c2-as-vs-satisfies) `as` vs `satisfies EntryData`      | types   | Med  | C       | S      | dsl-helpers.ts                                                 |
| [C3](#c3-factory-noops) helper-factories no-op casts         | dup     | Low  | Q       | S      | helper-factories.ts                                            |
| [C4](#c4-entrydata-mixins) `EntryData` render mixin + naming | types   | Med  | Q       | S      | context.ts                                                     |
| [C5](#c5-type-dedup) Type-level dedup (4 items)              | dup     | Med  | Q       | M      | route-types / type-extraction / helpers-types / response-types |
| [C6](#c6-message-consistency) Guard-message consistency      | name    | Med  | Q       | S      | dsl-helpers.ts                                                 |
| [C7](#c7-minor) Minor style nits (7)                         | misc    | Low  | Q       | S      | various                                                        |
| [P1](#p1-dual-form) Dual sibling/wrapper form                | API     | High | Q       | L      | dsl-helpers / helpers-types                                    |
| [P2](#p2-parallel-slot) `parallel()` slot two shapes         | API     | Med  | Q       | M      | dsl-helpers.ts                                                 |
| [P3](#p3-intercept-dot) `intercept()` leading-dot convention | API     | Med  | Q       | M      | dsl-helpers.ts                                                 |
| [P4](#p4-loading-false) `loading(false)` discoverability     | API     | Med  | Q       | S      | helpers-types.ts                                               |
| [P5](#p5-route-vs-path) `route()` vs `path()` + dead `map()` | API     | Low  | Q       | S      | helpers-types.ts                                               |
| [P6](#p6-cache-overload) `cache()` 5-behavior overload       | API     | Low  | R       | M      | dsl-helpers.ts                                                 |

---

# Part A — High-impact internal refactors

No consumer-visible change. These collapse the four patterns repeated across
nearly every helper into named primitives.

## A1. Collapse the context guard (and delete the dead branch) {#a1-context-guard}

`dsl-helpers.ts:64,110,155,179,220,409,486,651,744,809,852,911,959`,
`path-helper.ts:115`, `include-helper.ts:109`

Every helper opens with one of two shapes:

```ts
// shape 1
const ctx = getContext().getStore();
if (!ctx) throw new Error("revalidate() must be called inside map()");
// shape 2
const store = getContext();
const ctx = store.getStore();
if (!ctx) throw new Error("cache() must be called inside map()");
```

Two problems. First, `getStore()` (`context.ts:354-362`) **already throws** when
no store exists, so the `if (!ctx) throw …` branch is **unreachable dead code** —
the bespoke per-helper message has never fired. Second, the two shapes diverge
gratuitously.

**Adopt (verified safe):** one helper that returns `{ store, ctx }` and, because
the message is currently dead, accepts the message so the now-_reachable_ text
stays per-call-site. Use the raw, undefined-tolerant accessor for the live null
check:

```ts
// resolve-handler-use.ts or a small dsl util
export function requireDslContext(message: string) {
  const store = getContext();
  const ctx = store.context.getStore(); // raw ALS read, undefined-tolerant
  if (!ctx) throw new Error(message);
  return { store, ctx };
}
// call site
const { store, ctx } = requireDslContext("cache() must be called inside map()");
```

This unifies ~16 sites, removes the second redundant `getContext()` call in the
attach-only helpers, and makes the guard message **live** for the first time. No
test asserts the current text (verified), so this is invariant-free — but see
[C6](#c6-message-consistency) on what the message should _say_.

Risk: none. Confined to the context-acquisition preamble.

## A2. One `EntryData` base factory {#a2-entrydata-literal}

`dsl-helpers.ts:276,322,429,539,566,870,918,979`, `path-helper.ts:216`,
`context.ts:601`, `router.ts:710`

The ~14-field segment literal is hand-written 8–9 times. The constant part is
always the same empty-collection block:

```ts
loading: undefined,
middleware: [], revalidate: [], errorBoundary: [], notFoundBoundary: [],
layout: [], parallel: {}, intercept: [], loader: [],
...(urlPrefix ? { mountPath: urlPrefix } : {}),
```

**Adopt the base-spread form — NOT a generic `<T> … as T` factory** (the naive
form is in [Traps](#appendix-traps--do-not)). The factory returns only the
invariant base; each call site spreads it and adds its discriminant + specials so
the _final literal stays `satisfies EntryData`_ and keeps per-variant narrowing:

```ts
function emptySegmentBase() {
  const mountPath = getUrlPrefix();
  return {
    loading: undefined,
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: {},
    intercept: [],
    loader: [],
    ...(mountPath ? { mountPath } : {}),
  };
}
// layout()
const entry = {
  ...emptySegmentBase(),
  id: namespace,
  shortCode,
  type: "layout",
  parent: ctx.parent,
  handler: unwrappedHandler,
  ...(isStatic
    ? {
        isStaticPrerender: true as const,
        ...(handler.$$id ? { staticHandlerId: handler.$$id } : {}),
      }
    : {}),
} satisfies EntryData;
```

Apply to the ~8 from-scratch segment sites only. **Do not** route the `parallel`
per-slot clone (`dsl-helpers.ts:566-586`) through it — that path needs fresh deep
copies of the arrays; give it a distinct `cloneParallelSlot(entry, slotName)`.
Exclude `InterceptEntry` (different type).

Risk: type-coverage regression _only if_ the generic-`as T` form is used; the
base-spread form keeps `satisfies` checking. Gate on `typecheck` +
`semantic-matrix` + tree-structure suite.

## A3. One `runAndValidateUseItems()` {#a3-run-flat-validate}

`dsl-helpers.ts:343,450,608,718,780,888,947,1015`, `path-helper.ts:304`

The "run children, flatten, assert they are use items" block is repeated 8–9
times:

```ts
const result = store.run(namespace, entry, mergedUse)?.flat(3);
invariant(
  Array.isArray(result) && result.every((item) => isValidUseItem(item)),
  `route() use() callback must return an array of use items [${namespace}]`,
);
```

**Adopt, parameterizing the noun so messages stay byte-identical** (`cache`/
`transition` say "children callback"; the rest say "use() callback"):

```ts
function runAndValidateUseItems(
  store,
  namespace,
  entry,
  cb,
  label: string,
  kind: "use" | "children",
): AllUseItems[] {
  const result = store.run(namespace, entry, cb)?.flat(3);
  invariant(
    Array.isArray(result) && result.every(isValidUseItem),
    `${label}() ${kind === "use" ? "use()" : "children"} callback must return an array of use items [${namespace}]`,
  );
  return result as AllUseItems[];
}
```

`intercept`/`loader` (which flatten a pre-invoked callback) get a sibling
`validateUseItems(items, label, kind)`. `middleware` keeps its variadic pre-check
and migration invariant inline, then calls the shared validator for the final
step. This puts the `.flat(3)` depth in one place and enables a future
"name the offending item" upgrade.

Risk: none beyond message text, which the parameterization preserves.

## A4. One `attachOrphanSibling()` + `isOrphan()` {#a4-orphan-registration}

`dsl-helpers.ts:46,350,465,895,1023`, `context.ts:601`

The load-bearing orphan tail is open-coded 4 times:

```ts
const hasRoutes =
  result && Array.isArray(result) && result.some(hasRoutesInItem);
if (!hasRoutes) {
  const parent = ctx.parent;
  if (parent && "layout" in parent) {
    entry.parent = null; // LOAD-BEARING
    parent.layout.push(entry);
  }
}
```

**Adopt, with the null guard preserved** (only `middleware`'s copy has it today —
centralizing hardens the other three):

```ts
const isOrphan = (result: AllUseItems[]): boolean =>
  !result.some((item) => item != null && hasRoutesInItem(item));

/** Orphan structural entry (no routes inside) renders as a layout sibling.
 *  Clearing entry.parent removes it from the middleware/parent-pointer chain so
 *  it is not processed twice. LOAD-BEARING — see docs/tree-structure.md. */
function attachOrphanSibling(parent: EntryData | null, entry: EntryData): void {
  entry.parent = null;
  if (parent && "layout" in parent) parent.layout.push(entry);
}
```

`cache`/`middleware`/`transition` tails become
`if (isOrphan(result)) attachOrphanSibling(ctx.parent, entry)`. **`layout()` keeps
its extra validation inline** (nested-orphan rejection, root allowance,
parent-type whitelist — these run only there) and calls the same clear-then-push
at its single push point so the doc comment has one home. This is also where the
single canonical explanation of orphan semantics should live.

Risk: tree-structure orphan contract + semantic matrix — safe _only_ if the
helper does exactly clear-then-push and the null guard is kept. Gate on
`semantic-matrix` + tree-structure tests.

## A5. One source of truth for the use-item vocabulary {#a5-use-item-vocabulary}

`dsl-helpers.ts:1076`, `path-helper.ts:43`, `resolve-handler-use.ts:41`,
`route-types.ts:225`

The set of valid use-item `type` strings is encoded **four times**: two
byte-identical `isValidUseItem` arrays (dsl-helpers + path-helper), the per-mount
`MOUNT_SITE_ALLOWED_TYPES` Sets, and the type-level `*UseItem` unions.

**Adopt:**

1. Define `ALL_USE_ITEM_TYPES = new Set<AllUseItems["type"]>([...])` in a tiny
   runtime module (keep `route-types.ts` type-only) — the typed `Set` gives a
   compile-time exhaustiveness check against `AllUseItems`.
2. Keep `isValidUseItem` as the single exported predicate in `dsl-helpers.ts`
   (`item == null || (typeof item === "object" && "type" in item && ALL_USE_ITEM_TYPES.has(item.type))`);
   delete the `path-helper.ts` copy and import it (verified one-way edge, no
   cycle).
3. **Keep the per-site `MOUNT_SITE_ALLOWED_TYPES` Sets hand-written** — they are
   narrower subsets that `response`/`loader`/`parallel` rely on; do not derive
   them from `ALL_USE_ITEM_TYPES` (would widen validation). Add a cross-reference
   comment, and fix the stale file comment (`resolve-handler-use.ts:36-40` still
   names `LayoutUseItem`).

Risk: none if the per-site subsets stay hand-written. `route-types.ts` would gain
one side-effect-free runtime value if the Set is co-located there; the tiny-module
option avoids that.

## A6. One `splitConfigAndChildren()` {#a6-arg-disambiguation}

`dsl-helpers.ts:224,368,842`, `path-helper.ts:137`

The "is the first arg config or the children callback?" disambiguation is
re-derived four different ways.

**Adopt for the trio that genuinely shares the rule — `transition`, `path`, and
`cache`'s tail — but NOT `middleware`:**

```ts
function splitConfigAndChildren<C>(
  first: unknown,
  second: unknown,
  isConfig: (v: unknown) => v is C,
) {
  if (typeof first === "function")
    return { config: undefined, children: first as () => any[] };
  if (isConfig(first))
    return {
      config: first,
      children: typeof second === "function" ? second : undefined,
    };
  return { config: undefined, children: undefined };
}
```

Required guards: `cache` keeps its `undefined→{}`, `string→profile`, and
**`false`→disable** branches as explicit pre-steps (only the `{object|function}`
case funnels through the splitter); `middleware` stays fully bespoke (its
array-first-arg + arity-rejection form does not fit, and forcing it in obscures
the very logic that is special). Pin `cache(false)`, `cache(false, children)`,
`middleware([fn1,fn2], children)`, and `transition(children)` with a unit test.

Risk: silent per-call-form drift if the generic `isConfig` swallows `cache`'s
`false`. Honoring the pre-steps makes it safe.

## A7. `getShortCode` prefix map + `bumpCounter()` {#a7-shortcode}

`context.ts:371-424`

The type→prefix map is a 5-level nested ternary and the
`counters[k] ??= 0; const i = counters[k]; counters[k] = i + 1` idiom appears
three times (`getNextIndex`, root branch, child branch).

**Adopt** a module-scope `SHORT_CODE_PREFIX: Record<"layout"|"parallel"|"route"|"loader"|"cache", string>`
(exhaustive — a missing key becomes a compile error instead of the silent
`else "R"`) and a `bumpCounter(store, key): number` that the three call sites
format into their existing template literals.

Risk: **low, not none** — shortCodes are wire-stable. The refactor preserves
prefix letters, counter-key composition, `includeScope`/`mountPrefix` placement,
and post-increment, so the strings stay byte-identical. Gate on the e2e suites
that assert concrete segment IDs (`cache.test.ts`, `parallel-loader-reval.test.ts`,
`content-ownership.test.ts`, `perf-tracks.test.ts`) in dev **and** production.

## A8. One `joinUrlPrefix()` {#a8-url-prefix}

`path-helper.ts:76`, `include-helper.ts:124`, `context.ts:511`,
`build/route-types/include-resolution.ts:339` (fourth, uncited copy)

The "join prefix + path without doubling the slash" logic is copy-pasted four
times. **Adopt** a pure `joinUrlPrefix(prefix, pattern, opts?)` in a shared url
util, with an early `if (!prefix) return …` and a `{ rootIsPrefix: true }` option.
Wire `rootIsPrefix: true` **only** at the `path-helper` site (so `path('/')` under
a prefix stays the bare prefix); `include` and `runWithPrefixes` call it without
the option. Fold in the build-env copy in the same change (confirm it is
import-safe in the route-types environment). Pin with 4 assertions.

Risk: trie matching depends on `path('/')` resolving to the bare prefix — held
only if `rootIsPrefix` is wired exactly at the one site.

## A9. Share the route-entry engine between `path()` and `route()` {#a9-shared-engine}

`path-helper.ts:108-313`, `dsl-helpers.ts:911-957`

`path()` rebuilds `route()`'s core (entry construction, `mergeHandlerUse`, run +
flat + validate) by hand. This is the duplication that matters most
conceptually — see [Concept](#part-c--a-better-concept-of-handling).

**Adopt a narrow, behavior-preserving extraction** (not an atomic `set+run`
factory):

1. `createBaseRouteEntry({ namespace, shortCode, parent, handler })` returns only
   the common literal with **fresh `[]`/`{}` per call** (no module-level mutable
   constants), typed `satisfies EntryData`. `route()` spreads it; `path()` spreads
   it then adds `pattern`/`mountPath`/`isPrerender`/`responseType`/etc.
2. `runUseAndCollect(store, namespace, entry, mergedUse, label)` does only the
   `store.run(...)?.flat(3)` + `isValidUseItem` invariant. Both callers keep
   computing `mergedUse` themselves (preserving the per-mountSite arg and merge
   order) and keep deciding _when_ to call it.
3. Share the single `isValidUseItem` ([A5](#a5-use-item-vocabulary)).

**Do not** bundle `manifest.set` into the run block, and **do not** move
`getShortCode` into the factory — `path()`'s prune-fork (`path-helper.ts:184`)
calls `getShortCode` without building an entry, and `path()` intentionally runs
its use callback _after_ its pattern side effects. This captures ~80% of the
anti-drift win at low risk.

Risk: handler.use merge order, shortCode determinism, manifest-registration
ordering — all preserved by keeping merge/run _timing_ in the callers. Gate on
`semantic-matrix` + reverse/segment + dev/prod e2e.

## A10. Name the `tempParent` retargeting: `withParent()` {#a10-tempparent}

`dsl-helpers.ts:686-739` (intercept), `762-801` (loader)

Both helpers build a throwaway `tempParent`, swap `ctx.parent`, run a callback,
and restore — but the save/restore plumbing is duplicated and there is no
restore-on-throw. **Adopt a minimal save/restore guard that takes a pre-built
parent** (so each site keeps its bespoke shape, including intercept's `loading`
get/set accessor and `capturedLayouts`):

```ts
function withParent<T>(ctx: HelperContext, temp: EntryData, fn: () => T): T {
  const original = ctx.parent;
  ctx.parent = temp;
  try {
    return fn();
  } finally {
    ctx.parent = original;
  }
}
```

`loader` and `intercept` build `tempParent` exactly as today, call
`withParent(ctx, tempParent, …)`, then keep their existing post-run steps (loader
cache-diff; intercept layout lift). **Do not** force both through one
`{...base, ...overrides}` spread — that collapses intercept's `loading` accessor
to a value and breaks write-through. The added `try/finally` is a deliberate
restore-on-throw improvement; flag it.

Risk: intercept `loading` write-through + layout lift — preserved only if each
site keeps its own `tempParent` shape. Gate on intercept e2e + `semantic-matrix`.

---

# Part B — Dead code & silent-drift removals

Highest clarity-per-risk. All confirmed safe; mostly type-only.

## B1. Remove dead `PathDefinition` / `definitions` {#b1-dead-pathdefinition}

`urls-function.ts:38,84`, `pattern-types.ts:60-65,76`, `urls/index.ts:16`

`const definitions: PathDefinition[] = []` is created empty, exposed on
`UrlPatterns`, and **never written or read**. Delete the const, the field, the
`PathDefinition` interface, its barrel export, the now-unused type import
(`urls-function.ts:6`), and the `expect(patterns.definitions).toEqual([])`
assertion. This is exactly the "remove transitional/dead API rather than
deprecate" rule. (Recategorize as dead-code, not concept.)

## B2. Remove unimplemented `Extract*` stubs {#b2-dead-extract-stubs}

`type-extraction.ts:300-315`, `urls/index.ts:25-26`

`ExtractRouteNames` and `ExtractPathParams` are exported (via the `/urls`
subpath — _not_ the root barrel) but ignore their input and return `string`.
Delete both and their re-exports. **Do not** add a speculative `RouteNamesOf<T>`
replacement — implement that only when a real call site needs it.

## B3. Remove inert `Depth` guard + `Simplify` {#b3-inert-depth}

`type-extraction.ts:72-118,120-125,141,204`

The `Depth` recursion tuple and `Simplify` are declared, documented, and **never
applied** — the comments describing depth tracking are misleading. Delete `Depth`
and `Simplify`, drop the unused `D` type params and the `, 40` arguments, and fix
the three stale JSDoc lines. (Leave `route-config.ts`'s `Depth` — that one
works.) Verified to typecheck clean with all reverse-types tests green.

## B4. Remove the dead eager-include path {#b4-dead-eager-include}

`include-helper.ts:28-90`

`processItems` still carries an eager-include branch (`processIncludeItem`, the
`_expanded` cast) that can never run — all includes are lazy now. Reduce
`processItems` to: pass `include` items through, recurse into `layout.uses`, pass
everything else through. Delete `processIncludeItem`, drop only the unused
`runWithPrefixes` import (keep `getUrlPrefix`/`getNamePrefix`/`UrlPatterns`), and
fix the stale comment (`:95-101`) that still claims includes expand immediately.

## B5. Remove 14 dead phantom brand fields {#b5-dead-brands}

`route-types.ts:10-128`

Each `*Item` type carries a `[XBrand]: void` phantom symbol, but the real
discriminant is the `type` literal — the brands are never produced or read.
Lowest-risk form: **delete the 13 `declare const XBrand` + 13 `[XBrand]: void`
lines, leaving each type literal otherwise intact** (simpler and safer than
introducing a shared `DslItem` generic). Leave `IncludeItem`'s bespoke fields and
`UrlPatternsBrand` untouched. Pure type-level; invisible to e2e.

## B6. Single allow-list for `run` / `runWithStore` {#b6-run-divergence}

`context.ts:246,425,454`

`run()` and `runWithStore()` each hand-copy a _different_ subset of the ~17
`HelperContext` fields: `runWithStore` propagates `includeScope` but not
`patternsByPrefix`; `run` propagates `patternsByPrefix` but not `includeScope`.
This is a silent-drift hazard — a new field added to `HelperContext` is silently
dropped by both.

**Adopt the intent, not a blanket `{...store}` spread** (which would wrongly
propagate `patternsByPrefix` through lazy rebuilds). Define one named inherited
field-list and express each function as that list plus _explicitly documented_
deltas (`run` resets `includeScope`; `runWithStore` omits `patternsByPrefix`),
each delta annotated with the test that pins it. Add a
`satisfies Record<keyof HelperContext, …>`-style guard so a future field forces a
decision at compile time. Keep `run()`'s no-store fallbacks.

Risk: lazy-include isolation + route-index construction. Gate on
`lazy-include-isolation.test.ts`, `manifest-cache.test.ts`, `semantic-matrix`
(dev + prod).

---

# Part C — Naming, style & type polish

## C1. Drop the `*Fn` suffixes; one export block {#c1-fn-suffix}

`dsl-helpers.ts:744,809,838,911,1102-1134`, `helper-factories.ts:13-17`

`route`/`layout`/`cache`/`middleware` are named plainly, but `routeFn`/`loaderFn`/
`loadingFn`/`transitionFn` carry a `Fn` suffix and are aliased on export — for no
reason. Rename the four declarations to their plain names, collapse the two export
blocks into one (keep `loader`/`loading`/`transition` as the exported value names —
`route-definition/index.ts:36-38` re-exports them), update the `helper-factories`
imports/casts, and make `hasRoutesInItem`/`isOrphanLayout` file-private (zero
external importers). Pure lexical rename; no dynamic identifier lookups exist.

## C2. `as EntryData` → `satisfies EntryData` {#c2-as-vs-satisfies}

`dsl-helpers.ts:293,340,445,886` (literals) + `716,778` (tempParent casts)

The from-scratch entry literals use `} as EntryData` — which **disables** the type
check exactly at the unsafe construction sites — while others use `satisfies`.
Swap the four literal terminators to `satisfies EntryData` (verified: compiles
clean today). Leave the two `tempParent as EntryData` casts as casts (their
`type:"loader"` sentinel is not an `EntryData` member) and add a one-line comment
explaining why. This stands alone — do not couple it to [A2](#a2-entrydata-literal).

## C3. Collapse helper-factories no-op casts {#c3-factory-noops}

`helper-factories.ts:25-129,155-199`

The 13 `createXHelper` wrappers are identity casts and the helpers object is
duplicated verbatim. Replace with one `buildRouteHelpers<T, TEnv>()` returning the
helpers object via a single `as unknown as RouteHelpers<T, TEnv>`, deleting ~105
lines. (Use the actual imported identifiers — `routeFn`/`loaderFn`/etc. unless C1
lands first.) Low-severity cosmetic win.

## C4. `EntryData` render mixin + `EntryProp*` naming {#c4-entrydata-mixins}

`context.ts:76-81,160-230`

(a) Factor the `loading`/`transition` fields, duplicated across all four union
arms, into `type EntryPropRender = { loading?: ReactNode | false; transition?: TransitionConfig }`
applied to all arms. **Do not** widen the `cache` arm with static-prerender fields
— `cache-lookup.ts:397-403` relies on the `cache` arm _lacking_ `isStaticPrerender`
for its narrowing. (b) Rename the misleadingly-named mixins: `EntryPropDatas` →
`EntryPropInherited` (these are ancestor-resolved, not a single chain) and
`EntryPropSegments` → `EntryPropChildren`, each with JSDoc explaining the actual
resolution mechanism (loader lives with children because it is _owned_, not
inherited). The JSDoc alone captures most of the value at near-zero risk.

## C5. Type-level deduplication (4 sub-items) {#c5-type-dedup}

- **`Typed*Item` phantom-children** (`route-types.ts:37,55,134,194`): the three
  children-carrying variants are copy-pasted — collapse to one
  `WithChildren<TBase, TChildRoutes, TChildResponses>` generic (keep the explicit
  constraints; leave `TypedRouteItem`/`TypedIncludeItem` as-is).
- **Twin extraction conditionals** (`type-extraction.ts:141,240`):
  `ExtractRoutesFromItem` and `ExtractResponsesFromItem` are mirror 4-way
  conditionals — factor _only_ the three identical child-carrying arms
  (`T extends { __childRoutes?: infer R } ? …`), keep the asymmetric route/include
  arms spelled out per function, and add cache()/transition()-wrapping cases to
  `reverse-types.test.ts` (currently untested — a silent-failure surface).
- **`RouteHelpers` / `PathHelpers` signatures** (`helpers-types.ts:232`,
  `path-helper-types.ts:244`): extract the truly-identical helpers
  (`middleware`/`revalidate`/`loading`/`errorBoundary`/`notFoundBoundary`/`when`)
  into shared aliases; **keep** `cache`/`transition`/`parallel`/`intercept`
  bespoke (their typed-children generics diverge). The `loader`/`parallel`/
  `intercept` `UseItems<X>` vs `X[]` drift is a separate, deliberate decision.
- **Response handler types** (`response-types.ts:39-87`): `ResponseHandler` /
  `JsonResponseHandler` / `TextResponseHandler` differ only by callback return —
  factor `ResponseHandlerOf<TReturn>` but **keep the distinct per-type JSDoc** on
  each public alias.

## C6. Guard-message consistency {#c6-message-consistency}

`dsl-helpers.ts` guards (12 sites), `path-helper.ts:117`, `include-helper.ts:111`

Every shared guard says **"must be called inside map()"** even though `urls()` is
the entry point now (`map()` is not even a public export, nor is `route()`). A
consumer who calls `loader()` out of scope is told to use a name that does not
exist. Standardize on **"must be called inside urls()"** to match the existing
`path()`/`include()` guards. Fold this into [A1](#a1-context-guard) so only the
generic-message guards funnel through `requireDslContext("…")`; leave the two
scope-specific ones — `when()` ("inside intercept()") and the path/include guards
— with their bespoke text. (Note for the PR: do **not** claim `route()` is
globally exported; it is reachable only through the builder's helpers object.)

## C7. Minor style nits {#c7-minor}

Small, low-risk, batch with C1–C6:

- **`cacheUrlPrefix2`** (`dsl-helpers.ts:320`): drop the `2` suffix (per-branch
  scopes don't collide). Optionally standardize prefix locals to `urlPrefix`.
- **Stray `$` on dead `name` fields** (`dsl-helpers.ts:73,119,166,193,256,…`):
  the `$$`-producing sites feed a never-read `name`. Fix **only** the dead-`name`
  sites; **never** touch `namespace`/`id`-bearing strings (wire-stable). Better:
  question whether `name` belongs on leaf items at all.
- **`transition()` double counter-increment** (`dsl-helpers.ts:856,869`): the
  wrapper branch allocates a dead `name` and advances the transition counter
  twice. Allocate the index once — but **keep the `$` prefix** on `name`
  (`$${index}`) to match every sibling helper.
- **`redirect()` basename density** (`redirect.ts:52-101`): extract
  `prefixBasename(url, basename)` with early returns; rename `bn` → `basename`.
  Leave the status/state ternaries alone. Add a 4-case unit test (none currently
  exists).
- **`helpers-types.ts` re-export omits `LoadingItem`/`TransitionItem`**
  (`:39-57`, `index.ts:3-23`): add the two genuinely-missing names to both blocks
  (`LoaderItem` is already present). **Do not** use `export type *` — it leaks 28
  internal types.
- **`path()` wrappedHandler cascade** (`path-helper.ts:189-256`): flatten the
  nested ternary, hoist `resolveResponseType(options)` once (currently called
  twice), and reuse the outer `urlPrefix` instead of shadowing it. Keep the
  explicit `as Handler<…>` casts.
- **`urls()` helper assembly** (`urls-function.ts:47-73`): spread the base helpers
  and cast once (`as unknown as PathHelpers` — the cast covers both phantom
  generics _and_ the extra `route` key) instead of re-stating each helper with
  scattered `as any`; fixes the stale comment that names only layout/cache.

---

# Part D — Consumer-facing DSL ideas (flagged)

These change what a consumer writes. Per the pre-release hygiene rule, any of
these must land with skills + examples + test-app updated in the **same** PR (no
deprecation window). Treat them as design proposals, not confirmed cleanups.

## P1. The dual sibling-vs-wrapper form {#p1-dual-form}

`cache()`/`middleware()`/`transition()` encode _scope_ in argument arity:
`middleware(fn)` attaches to the parent; `middleware(fn, () => [...])` wraps a
subtree. The scope difference is invisible at a glance.

Two correctness caveats sharpen — and complicate — this:

- The bare form is a _true_ sibling-attach only for `middleware`/`transition`.
  **Bare `cache()` already wraps** (it creates an orphan entry and reassigns
  `ctx.parent`, "sugar for `cache(() => [...])`") and has a loader-entry special
  case. So the arity overload isn't even consistent across the three.

Proposal: introduce an explicit wrapping helper (a documented `scope()`/`group()`)
implemented on the existing layout/cache machinery, prototype it _behind_ the
current helpers, verify against `semantic-matrix` + `middleware-wrapping.test.ts`,
and only then decide whether to remove the dual form. Do not present `group()` as a
drop-in — it cannot uniformly replace all three given bare `cache()`'s wrapping.

## P2. `parallel()` slot has two incompatible shapes {#p2-parallel-slot}

A slot value is either a bare handler or a `{ handler, use }` descriptor; the
per-slot config form is undiscoverable and detected by a fragile
`!("__brand" in value) && "handler" in value` sniff. Proposal: a brand-tagged
`parallelSlot(handler, () => [...])` (prefer that name over a bare `slot` on the
public surface) that lets `isSlotDescriptor` collapse to a single brand check.
Preserve the three-layer merge order (`handler.use` → broadcast `use` → slot-local
`use`) verbatim, and ensure it composes with `Static()`.

## P3. `intercept()`'s leading-dot convention {#p3-intercept-dot}

`intercept("@modal", ".product", …)` vs `intercept("@modal", "product", …)` —
the leading `.` silently switches between local (prefix-applied, param-inferred
from `ResolvedRouteMap`) and global (`GeneratedRouteMap`) name resolution, and a
typo falls through to the wrong mode. Proposal: bare string = local; global
becomes an explicit, greppable `globalRoute("some.route")` tag, with the runtime
`startsWith(".")` sniff replaced by a brand check. Note the runtime inversion in
the PR (bare names inside an `include()` now receive the active name prefix) and
pin both paths with a unit test.

## P4. `loading(false)` discoverability {#p4-loading-false}

`loading(false)` is a documented opt-out (await before paint, no skeleton) but the
public signature doesn't name it. **Do not** "fix" it by widening the type to
`ReactNode | false` — `false` is already in `ReactNode`, so the widening is a
no-op. Instead: extend the JSDoc with an explicit `loading(false)` example (JSDoc
_is_ the hover surface), or — if signature-level visibility is required — express
`loading` as a method-style overload (`loading(component: false): LoadingItem`),
which TS renders verbatim. No runtime change.

## P5. `route()` vs `path()` asymmetry + dead `map()` {#p5-route-vs-path}

Consumers write `path()`/`include()`, yet `RouteHelpers` and the skills still
expose `route()`. The actionable item is the larger question this grazes:
**are `map()` / `route()` / `RouteHelpers` dead transitional API to remove** under
the pre-release hygiene rule? `urls()` "replaces `map()`", `map` is not in the
public root export, and `route()` has zero real consumer-source usage. Decide
deliberately: remove (scoped as its own PR with full build + `semantic-matrix`
verification) or document why they are intentionally kept. Do not ship the
in-between "asymmetry note."

## P6. `cache()`'s five-behavior overload — REJECTED {#p6-cache-overload}

`cache()` collapses five behaviors (defaults, `cache('profile')`, options,
`cache(false)` disable, wrapper) into one overload. The proposed fix (drop the
string arm, add `cache.off()`/`cache.profile()`) is **rejected**: `cacheProfiles`
is a shipping feature documented across three skills, and `cache.off()` would
contradict the established `loading(false)` disable-by-literal convention. If
opacity is a concern, the only defensible step is **documentation** — split the
JSDoc into labeled sections per call form — plus optionally accepting
`cache({ enabled: false })` as an _additive_ alias, and only as part of a
DSL-wide disable-convention pass, not piecemeal.

---

# Part E — A better concept of "handling"

The findings above are mechanical. The conceptual through-line — what would make
the DSL genuinely easier to _follow_ — is four named ideas the code currently
leaves implicit.

### 1. One engine, two leaf helpers

`map()` and `urls()` are the same builder; `route()` and `path()` are the same
operation (place a leaf) differing only in whether the URL is a name or a pattern.
Today `path()` re-implements `route()`'s entry construction, `mergeHandlerUse`,
and run/flat/validate by hand ([A9](#a9-shared-engine)). The target concept: a
single **segment engine** (`createBaseRouteEntry` + `runUseAndCollect` +
`mergeHandlerUse`) that both leaf helpers call, with `path()` adding only pattern
bookkeeping. This removes the field-list drift, the `as`-vs-`satisfies`
inconsistency, and the second copy of `isValidUseItem` in one move.

### 2. Name the three retargeting mechanisms

The DSL changes where children attach in three _distinct_ ways that today live
only as prose comments:

| Mechanism                                | Operation                                                 | Effect                                                                           | Today                                                    |
| ---------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Orphan**                               | `entry.parent = null; parent.layout.push(entry)`          | entry leaves the parent chain, renders as a sibling wrapper                      | open-coded 4× ([A4](#a4-orphan-registration))            |
| **Open boundary** (bare `cache()`)       | `ctx.parent = entry`                                      | permanently retargets the downward cursor; following siblings nest under `entry` | inline, uncommented (`dsl-helpers.ts:302`)               |
| **`tempParent` swap** (intercept/loader) | redirect attachments into a satellite entry, then restore | nested helpers populate a non-tree entry                                         | duplicated, no restore-on-throw ([A10](#a10-tempparent)) |

Giving each a named primitive (`attachOrphanSibling`, an `openBoundary`/cursor
helper with the comment block from [Concept §below], `withParent`) makes the
implicit data flow greppable. **Critically, these are NOT the same operation** —
the orphan path sets `entry.parent = null` and leaves `ctx.parent`; the
open-boundary path sets `ctx.parent = entry` and keeps `entry.parent`. A reviewer
flagged that conflating them (a tempting "unification") is wrong. Naming them
separately is the fix precisely _because_ it prevents that confusion.

### 3. One vocabulary, one source of truth

The set of valid use-item types is encoded four times ([A5](#a5-use-item-vocabulary)).
The concept: one runtime `ALL_USE_ITEM_TYPES`, exhaustiveness-checked against the
`AllUseItems` union, drives shape validation everywhere; the per-mount-site rules
remain _explicit, hand-written subsets_ (they are genuinely narrower, not
derivable). "What is a use item?" gets one answer; "what is allowed _here_?" stays
a visible, local decision.

### 4. `EntryData`: one base shape, typed deltas

An `EntryData` is "the shape of a segment." Today that shape is copy-pasted at
every construction site, and the copies have already drifted (`as` vs
`satisfies`). The concept: `emptySegmentBase()` owns the invariant collections;
each call site contributes only its discriminant and type-specific fields; the
final literal stays `satisfies EntryData` so per-variant mistakes are still caught
([A2](#a2-entrydata-literal), [C2](#c2-as-vs-satisfies)). "Add a new collection to
every segment" becomes a one-line edit instead of a nine-site sweep.

---

# Proposed PR plan

Grouped by risk so the cheap, high-confidence wins land first and the
invariant-sensitive engine work is isolated.

### PR 1 — Dead-code removals (Part B, except B6)

Files: `urls-function.ts`, `pattern-types.ts`, `urls/index.ts`,
`type-extraction.ts`, `include-helper.ts`, `route-types.ts`.
Actions: B1–B5. Acceptance: `typecheck` + `test:unit` green; no remaining
references; surface reflects reality.

### PR 2 — Naming, style & type polish (Part C)

Files: `dsl-helpers.ts`, `helper-factories.ts`, `context.ts`, `route-types.ts`,
`helpers-types.ts`, `path-helper-types.ts`, `response-types.ts`, `redirect.ts`,
`urls-function.ts`, `path-helper.ts`. Actions: C1–C7. Acceptance: full pre-push
gate (`typecheck`, `test:unit`, `lint`, `format`); guard-message change verified
by a manual out-of-scope call (no test asserts the text).

### PR 3 — Core dedup primitives (Part A: A1–A8)

Files: `dsl-helpers.ts`, `context.ts`, `path-helper.ts`, `include-helper.ts`, a
new dsl/url util module. Actions: `requireDslContext`, `emptySegmentBase`,
`runAndValidateUseItems`, `attachOrphanSibling`/`isOrphan`,
`splitConfigAndChildren`, `SHORT_CODE_PREFIX`/`bumpCounter`, `joinUrlPrefix`,
single `isValidUseItem`/`ALL_USE_ITEM_TYPES`. Acceptance: full gate +
`semantic-matrix` (dev + prod) + tree-structure suite + the segment-id-asserting
e2e suites (zero shortCode drift).

### PR 4 — Shared engine + scope handling (Part A: A9, A10, B6)

Files: `path-helper.ts`, `dsl-helpers.ts`, `context.ts`. Actions:
`createBaseRouteEntry`/`runUseAndCollect` shared by path/route, `withParent`,
`run`/`runWithStore` allow-list + compile-time guard. Acceptance: full gate +
`semantic-matrix` + reverse/`lazy-include-isolation`/`manifest-cache` + dev/prod
e2e. Highest scrutiny — this is the engine.

### Part D (consumer API) — separate, deliberate design PRs

Each of P1–P5 is its own change with skills + examples + test-app updated in the
same PR. P6 is documentation-only. Do not bundle these with A–C.

---

# Appendix: Traps — do NOT {#appendix-traps--do-not}

The adversarial-verification pass found these naive forms break something. They
are recorded so they are not re-attempted.

- **`EntryData` factory must not be `<T extends EntryData>(…): T` with `as T`** —
  it silently downgrades per-variant `satisfies` checking (a route-only `pattern`
  on a layout entry would no longer be caught). Use the base-spread form
  ([A2](#a2-entrydata-literal)).
- **Do not route `parallel`'s per-slot clone through the base factory** — it would
  alias the slot arrays (tree-structure-sensitive). Keep a distinct
  `cloneParallelSlot`.
- **Do not widen `loading`'s type to `ReactNode | false`** — `false ∈ ReactNode`,
  so it is a no-op. Use JSDoc or an overload ([P4](#p4-loading-false)).
- **Do not drop `RESPONSE_TYPE`'s `unique symbol` annotation** — under
  `isolatedDeclarations: true` it fails with TS9010. Only the redundant `as any`
  should go (`response-types.ts:35`).
- **Do not change `when()`'s _second_ invariant message** — it is asserted
  verbatim by `router-integration-2.test.tsx:438` and
  `router-integration.test.tsx:1019`. Only the dead first-guard message may be
  relabeled.
- **Do not remove `cache('profile')` or add `cache.off()`** — profiles ship across
  three skills; breaks API hygiene + the `loading(false)` parity ([P6](#p6-cache-overload)).
- **Do not move `getShortCode` into the path/route base factory** — `path()`'s
  prune-fork calls it without building an entry; co-locating would skip or double
  the allocation ([A9](#a9-shared-engine)).
- **Do not unify `run`/`runWithStore` with a blanket `{...store}` spread** — it
  would propagate `patternsByPrefix` through lazy manifest rebuilds, changing what
  `path()` registers ([B6](#b6-run-divergence)).
- **Do not conflate orphan (`entry.parent = null`) with open-boundary
  (`ctx.parent = entry`)** — different operations; naming them separately is the
  point ([Concept §2](#part-e--a-better-concept-of-handling)).
- **Do not change any shortCode / segment-id / namespace string** — wire-stable;
  they feed reconciliation and `router.named-routes.gen.ts`. Touch only the
  provably-dead `name` fields ([C7](#c7-minor)).
- **Do not derive `MOUNT_SITE_ALLOWED_TYPES` from `ALL_USE_ITEM_TYPES`** — the
  per-site Sets are intentionally narrower ([A5](#a5-use-item-vocabulary)).
