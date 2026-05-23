# `ctx.isAction()` — typed, rename-safe action matching for `revalidate()`

**Status:** Proposed. Not implemented. This doc captures the design so the
skills can reference it as planned without documenting a non-existent API.

## Problem

`revalidate()` predicates match server actions by substring on the action id:

```ts
revalidate(
  ({ actionId }) => actionId?.includes("src/actions/cart.ts#") ?? false,
);
```

`actionId` is a `path#export` string because that is the only stable reference
React server actions expose across the Flight boundary. The string is therefore
the correct _floor_. But the developer **surface** does not have to be a
hand-written substring:

- A renamed action (`addToCart` → `addItem`) or a moved file silently stops
  matching. No compile error; the route just stops revalidating.
- The match is amplified by composition: a substring match inside a shared
  factory (`/composability`) drifts across every route that composes it.
- `includes("cart.ts#")` is doing two different jobs — "this exact action" and
  "any action in this module" — with no way to tell which was intended.

## Background: how action identity works today

Action ids are injected at build by `src/vite/plugins/expose-action-id.ts`:

| Bundle     | Reference call                 | Injected property | Value form            |
| ---------- | ------------------------------ | ----------------- | --------------------- |
| Client     | `createServerReference(...)`   | `fn.$$id`         | `"<hash>#export"`     |
| RSC server | `registerServerReference(...)` | `fn.$id`          | `"<filePath>#export"` |

`$id` (single dollar) is used on the server because React makes `$$id`
non-writable on `registerServerReference` output. Only **module-level
`"use server"`** files get the file-path form; inline actions keep hashed ids
for client security.

The `actionId` delivered to a `revalidate()` predicate is the RSC server form
(`"src/actions/cart.ts#addToCart"`). The predicate runs in the RSC environment,
which is also where `urls.tsx` and any imported action references live — so an
imported action reference there already carries `$id`.

Loaders and handles already inject `$$id` (`{modulePath}#{exportName}`) via the
sibling `exposeInternalIds` plugin. So "resolve a stable id from an imported
reference" is an established pattern; this proposal extends it to the
`revalidate()` surface for actions.

## Proposed API

```ts
interface RevalidateContext {
  actionId: string | null; // keep — React-forced floor / escape hatch
  defaultShouldRevalidate: boolean;
  isAction(...actions: ActionRef[]): boolean; // typed sugar over actionId
}
```

`ActionRef` is an imported server-action reference (or a `import * as Mod`
namespace, see "Module form").

Semantics:

- Resolves each `ActionRef`'s injected id and compares it to `actionId`.
- Returns `false` when there is no action (plain navigation) or no match.
- Variadic: `ctx.isAction(CartAdd, CartRemove)`.
- **Module form** (replaces the file-path-prefix idiom):
  `ctx.isAction(CartActions)` where `import * as CartActions` → `true` if
  `actionId` is any export of that module. Typed equivalent of
  `includes("cart.ts#")`, covering both "this action" and "any action in this
  file" without strings.

### Before / after

```ts
// before
revalidate(
  ({ actionId }) => actionId?.includes("src/actions/cart.ts#") ?? false,
);
// after
revalidate((ctx) => ctx.isAction(CartActions) || undefined);
```

### Chain interaction (a footgun this repo's own rules create)

`ctx.isAction()` returns a **raw boolean**. Dropping it bare —
`revalidate((ctx) => ctx.isAction(CartAction))` — hard-falses on every non-match
and short-circuits the revalidation chain (see
`src/router/revalidation.ts`: a boolean return is a hard decision; `undefined`
defers). For the common "revalidate on match, else defer" intent, the predicate
must defer:

```ts
revalidate((ctx) => ctx.isAction(CartAction) || undefined);
```

If `|| undefined` becomes a papercut, a thin combinator earns its place — built
on `isAction`, not replacing it:

```ts
const onAction =
  (...a: ActionRef[]) =>
  (ctx: RevalidateContext) =>
    ctx.isAction(...a) ? true : undefined;

revalidate(onAction(CartAction)); // hard-true on match, defer otherwise
```

Primitive (`ctx.isAction`) for control; combinator (`onAction`) for the 90% path.

## Implementation sketch

1. **Type:** add `isAction(...actions: ActionRef[]): boolean` to the revalidate
   predicate argument type (`src/types/handler-context.ts`, alongside the
   existing `actionId`) and to `ShouldRevalidateFn` in
   `src/route-definition/helpers-types.ts`.
2. **Resolution:** when constructing the predicate argument object
   (`src/router/revalidation.ts`, the `fn({ ... })` call inside
   `evaluateRevalidation`), add an `isAction` closure that maps each `ActionRef`
   to its id and compares to `actionContext?.actionId`.
3. **Id resolution helper:** read `ref.$id ?? ref.$$id` for a single reference;
   for a `import * as Mod` namespace, test whether `actionId` equals any
   member's id. Centralize so the `$id`/`$$id` split (server vs client form)
   lives in one place.
4. **`ActionRef` type:** the public type for an imported server action; ensure
   `typeof someAction` is assignable.

## Open questions / risks

- **Server vs client id form.** The predicate runs in RSC, where references and
  `actionId` are both the file-path form, so resolution should compare cleanly.
  Confirm there is no path where a client-hash reference reaches the predicate.
- **Namespace resolution.** `import * as Mod` must expose every action's id at
  the point the predicate runs. Verify the RSC transform keeps namespace members
  resolvable (not tree-shaken) when only used inside a predicate.
- **Inline actions** keep hashed ids and are not file-path matchable; document
  that `isAction` targets module-level `"use server"` exports.
- **API hygiene (pre-release rule):** `actionId` stays as the floor/escape
  hatch; `isAction` is additive. No deprecation needed.

## Test plan (when implemented)

Per repo policy, e2e must cover **both dev and production**:

- Unit: `isAction(single)`, variadic, namespace form, no-action (navigation)
  returns `false`, no-match returns `false`, and `$id`/`$$id` resolution.
- e2e (dev + prod): an action triggers revalidation of a segment guarded by
  `ctx.isAction(...) || undefined`; a different action does not; a rename of the
  action surfaces as a type error (type-level test).
- Keep the semantic matrix green; if action→revalidate matching semantics
  change, update `docs/internal/execution-model.md` and the matrix rows.

## Net

- `actionId` stays as the floor (React gives nothing better).
- `ctx.isAction` is the typed surface that makes renames break at compile time.
- Pairs with the doc clarifications that keep the value-freshness ↔
  partial-render line legible (`/cache-guide` → "Two axes", `/rango` →
  "Glossary").
