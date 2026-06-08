# `ctx.isAction()` — typed, rename-safe action matching for `revalidate()`

**Status:** Implemented. This doc records the design and rationale. The API is
shipped on the revalidate predicate context; see `/loader` → "Matching actions:
`ctx.isAction()`" and `/typesafety` → "Stable identity" for usage.

If you've ever matched a server action in a `revalidate()` predicate by
substring-ing its id and felt the unease — this is why that footgun exists and how
`ctx.isAction()` closes it. The short of it: string matching breaks silently the
moment someone renames or moves the action, and the compiler can't warn you.

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
  actionId?: string; // keep — React-forced floor / escape hatch (undefined on navigation)
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

## Implementation

1. **Type:** `isAction(...actions: ActionRef[]): boolean` is on the revalidate
   predicate argument type — the single `ShouldRevalidateFn` arg in
   `src/types/handler-context.ts`, alongside `actionId`. `helpers-types.ts`
   consumes that type via import, so no change was needed there.
2. **`ActionRef` type:** the public type for an imported server action (or a
   `import * as Mod` namespace); exported from the package root. `typeof someAction`
   is assignable.
3. **Resolution:** the predicate argument object built in `evaluateRevalidation`
   (`src/router/revalidation.ts`) gets `isAction: makeIsAction(actionContext?.actionId)`.
4. **Helpers (`src/router/revalidation.ts`):** `resolveActionRefId(ref)` reads
   `ref.$id ?? ref.$$id`; `makeIsAction(currentId)` returns the variadic closure,
   matching a single reference or any export of a namespace import, and `false`
   when there is no action.

## Resolved questions

- **Dev vs production id form.** The decisive insight: the action boundary
  derives `actionContext.actionId` as `loadedAction.$id ?? loadedAction.$$id`
  (`src/rsc/server-action.ts`). `isAction` resolves the imported reference with
  the **same** precedence, and the imported reference and the loaded action are
  the same registered server reference — so matching holds regardless of whether
  the id is file-path (`$id`, production RSC) or hash (`$$id`, dev), with no need
  to reconcile the two forms.
- **Namespace resolution.** `import * as Mod` is passed as an argument, so its
  members stay live; `Object.values` over the namespace resolves each export's id
  and skips non-action members.
- **Inline actions** keep hashed ids; `isAction` still matches them by reference
  (it compares the same resolved id on both sides), though substring matching by
  file path does not apply to them.
- **API hygiene (pre-release rule):** `actionId` stays as the floor/escape
  hatch; `isAction` is additive. No deprecation needed.

## Tests

Per repo policy, e2e covers **both dev and production**:

- Unit (`src/router/__tests__/revalidation-isaction.test.ts`): single match,
  variadic, namespace form, `$$id` fallback, `$id`-over-`$$id` precedence,
  plain-navigation `false`, no-match `false`, and an unresolvable reference.
- e2e (`e2e/is-action.test.ts`, dev + production): the target action re-runs a
  loader gated by `revalidate(({ isAction }) => isAction(target))`; the decoy
  action does not.

## Net

- `actionId` stays as the floor (React gives nothing better).
- `ctx.isAction` is the typed surface that makes renames break at compile time.
- Pairs with the doc clarifications that keep the value-freshness ↔
  partial-render line legible (`/cache-guide` → "Two axes", `/rango` →
  "Coming from another framework").
