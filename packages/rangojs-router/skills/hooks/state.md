# State and Cache Control Hooks

## State Hooks

### useLocationState()

Read type-safe state from history:

```tsx
"use client";
import { useLocationState, createLocationState } from "@rangojs/router/client";

// Define typed state (all export patterns supported)
// Keys are auto-injected by the Vite plugin -- no manual key needed.
// In a unit test (no plugin), key it with withLocationStateKey(ProductState,
// "ProductState") from @rangojs/router/testing: outside production, an
// unkeyed definition throws on first use.
export const ProductState = createLocationState<{
  name: string;
  price: number;
}>();

// Also valid: const ProductState = createLocationState<...>();
//             export { ProductState };
// Also valid: export { ProductState as MyState };

function ProductHeader() {
  const state = useLocationState(ProductState);
  // { name: string; price: number } | undefined

  if (state) {
    return (
      <h1>
        {state.name} - ${state.price}
      </h1>
    );
  }
  return <h1>Loading...</h1>;
}
```

Pass state through Link:

```tsx
import { Link } from "@rangojs/router/client";
import { ProductState } from "./state";

<Link to="/product/123" state={[ProductState({ name: "Widget", price: 99 })]}>
  View Product
</Link>;
```

Pass typed state just in time (getter evaluated at click time, not render time):

```tsx
"use client"; // JIT state requires a client component (getter can't cross RSC boundary)

import { Link } from "@rangojs/router/client";
import { ProductState } from "./state";

// The getter is stored lazily and only called when the user clicks the link.
// This is useful for capturing values that change after render (e.g., scroll
// position, form state, ref values).
<Link
  to="/product/123"
  state={[ProductState(() => ({ name: product.name, price: product.price }))]}
>
  View Product
</Link>;
```

Plain state can also be evaluated just in time (also requires a client component):

```tsx
<Link to="/product/123" state={() => ({ from: window.location.pathname })}>
  View Product
</Link>
```

Read plain (untyped) state by calling the hook with a type argument and no
definition:

```tsx
const state = useLocationState<{ from?: string }>(); // { from?: string } | undefined
```

### State on router.push() / router.replace()

The same `state` option exists on `router.push()` / `router.replace()` (see
[`./navigation.md`](./navigation.md)), with the same type as `<Link state>`
(minus the click-time getter): `HistoryState`, which is
`readonly LocationStateEntry[]` (typed entries) or `PlainHistoryState` (plain,
structured-clone-safe data). Both types are exported from
`@rangojs/router/client`.

```tsx
"use client";
import { useLocationState, useRouter } from "@rangojs/router/client";
import { GridState } from "./state"; // createLocationState<{ count: number }>()

function LoadMore() {
  const router = useRouter();
  const grid = useLocationState(GridState);
  const count = grid?.count ?? 20;
  return (
    <button
      onClick={() =>
        router.replace("?page=2", { state: [GridState({ count: count + 20 })] })
      }
    >
      Load more
    </button>
  );
}
```

Typed entries always go in an array, with nothing else in it. Three mistakes
are compile errors:

```tsx
router.push(url, { state: GridState({ count: 3 }) }); // entry without the array
router.push(url, { state: [GridState] }); // definition, not called
router.push(url, { state: [GridState({ count: 3 }), { from: "list" }] }); // mixed
```

Without the array, the entry's own `__rsc_ls_*` fields would land on
`history.state` and `useLocationState(GridState)` would read `undefined`; an
uncalled definition throws `DataCloneError` in `history.pushState`; in a mixed
array only the first element picks the format, so the rest are lost. For
untyped (JS) callers, development builds throw an error for each that names
the definition's key (or the offending index) and the fix.

Plain state is checked at the top level only. It rejects functions, symbols,
`Promise`, `WeakMap`, `WeakSet`, and values typed `unknown` (narrow an
`unknown` value, or annotate it as `PlainHistoryState`). Array, `Map`, and
`Set` elements are checked the same way, but plain object members are not.
These still compile and still throw `DataCloneError` at `history.pushState`:

- a function, symbol, or React element inside a plain object
  (`{ onClose: () => {} }`);
- a top-level `ReactElement` or DOM node (`HTMLElement`), which look like
  plain objects to the type.

Store plain data and rebuild the rest on arrival, or use a typed
`createLocationState<T>()` definition, whose `T` is checked all the way down.

### When a type fails the serializability check

`createLocationState<T>()` rejects values that cannot survive
`history.state`'s structured clone: functions, class constructors, symbols,
React/RSC content, and fields typed `unknown`. The compile error names the
failing field and the reason:

```
Argument of type '{ items: never[]; cursor: string; }' is not assignable to
parameter of type '... & LocationStateUnsafe<"`unknown` cannot be verified as
serializable; give it a concrete type", "items[].info.values">'.
```

The path uses `.` for fields, `[string]` / `[number]` for index signatures
(`Record<string, T>`), `[]` for array and `Set` elements, `[0]` for tuple
elements, `<key>` / `<value>` for `Map` keys and values, and `<root>` when the
value itself is unsafe. A field typed `any` is never reported. When several fields fail, the error lists one `LocationStateUnsafe` per
path. An object's own unsafe fields are reported before anything nested
deeper, so a class instance or DOM node stops at its methods
(`row.el.click`); fix those and the next compile names the rest. The walk
stops 8 levels deep, reporting the deepest path it reached.

### Flash State (read-once)

Create a location state with `{ flash: true }` for read-once state that
auto-clears after first render. Ideal for flash messages (success/error
notifications after redirect):

```tsx
// location-states.ts
import { createLocationState } from "@rangojs/router";

export const FlashMessage = createLocationState<{ text: string }>({
  flash: true,
});
```

Read flash state with `useLocationState` (same hook as persistent state):

```tsx
"use client";
import { useLocationState } from "@rangojs/router/client";
import { FlashMessage } from "../location-states";

function FlashBanner() {
  const flash = useLocationState(FlashMessage);
  // { text: string } | undefined

  if (!flash) return null;
  return <div className="flash">{flash.text}</div>;
}
```

Flash behavior is determined by the definition (`{ flash: true }`), not by which
hook reads it. `useLocationState` reads the value during render (on the
hydration render it returns `undefined` and reads in a post-mount effect, so
SSR and hydration agree), then clears it from `history.state` via
`replaceState` in a `useEffect`. Multiple components reading the same flash
definition all see the value. Pressing back/forward will not re-show the flash
since it was cleared.

Set flash state from the server via `redirect()` with state (from a handler,
middleware, or server action). Import the definition from the shared module so
the client reader uses the same one:

```tsx
// In a route handler
import { redirect } from "@rangojs/router";
import { FlashMessage } from "../location-states";

(ctx) => {
  return redirect("/dashboard", {
    state: [FlashMessage({ text: "Item saved!" })],
  });
};
```

Or via `ctx.setLocationState()` from a handler or middleware. It is delivered
with a client navigation's or an action's response; a document response
carries no location state (there is no history entry to write it to yet):

```tsx
(ctx) => {
  ctx.setLocationState(FlashMessage({ text: "Welcome back!" }));
  return <Dashboard />;
};
```

### createLocationState options

```ts
createLocationState<TState>({
  flash?: boolean, // read once, cleared after paint (above)
  version?: number, // drop state written under another version
  validate?: (value: unknown) => value is TState, // check the value on read
  clearOnReload?: boolean, // drop the state on a document load
});
```

A definition that sets none of them stores the value under its key and reads
it back unchecked, as it always did. `version`, `validate` and `clearOnReload`
each make one kind of stored state read as `undefined`, which is what a reader
already handles: it is the same result as no state.

The value is always stored as-is. `version` and `clearOnReload` change the
slot's KEY in `history.state` instead, by a suffix on the key the Vite plugin
injects (`<key>` below, `__rsc_ls_<file>#<ExportName>`):

| Options                        | Key in `history.state` | Reads `undefined` when                                    |
| ------------------------------ | ---------------------- | --------------------------------------------------------- |
| none, `flash`, `validate`      | `<key>`                | the slot is empty (`flash`: once read; `validate`: below) |
| `version: 2`                   | `<key>~v2`             | nothing was stored under version 2                        |
| `clearOnReload`                | `<key>~r`              | the entry's document was loaded since the write           |
| `version: 2` + `clearOnReload` | `<key>~v2~r`           | either of the above                                       |

`Def.__rsc_ls_key` is that key, suffix included. `~` cannot appear in an export
name, so no other definition can end up with a suffixed key.

`version`, `validate` and one of `flash` / `clearOnReload` can be combined.
`flash` with `clearOnReload` is rejected: `createLocationState` throws in
development.

### version and validate: state from another deploy

The key is the file path plus the export name, so it stays the same across
deploys. History entries survive reloads and back/forward. A tab left open
across a release that changed the shape would otherwise restore the old value
typed as the new one.

`version` is the cheap check for a deliberate shape change. Bump it when the
shape changes:

```ts
export const GridState = createLocationState<GridSnapshot>({ version: 2 });
```

Version 2 reads and writes `<key>~v2` and nothing else. State stored by
version 1 (`<key>~v1`), or before the definition had a version (`<key>`), is
under another key, so the reader finds nothing and gets `undefined`. Nothing
is decoded and nothing is deleted: the older slot stays in that history entry
as a key nobody reads, until the entry is replaced or dropped by the browser.

`validate` checks the value itself, so it also covers state written by other
code under the same key. It runs on every read of a non-empty slot; `false`
reads as `undefined`.

```ts
export const GridState = createLocationState<GridSnapshot>({
  validate: (value): value is GridSnapshot => isGridSnapshot(value),
});
```

- An empty slot is `undefined` without calling `validate`.
- A `validate` that throws counts as `false`. It never fails the render or
  the navigation; in development the error is logged once per definition,
  with the definition's key.
- With `version`, it only ever sees values stored under that version.

The type of `validate` is exported as `LocationStateGuard<TState>` (not to be
confused with `ValidateLocationState<T>`, the compile-time serializability
check above).

**Rollbacks, and adding or removing an option.** Because the options are in
the key and the value is plain, no release ever reads a format it does not
know:

| Change                                          | What the definition reads afterwards                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| add `version` (or `clearOnReload`)              | `<key>~v1` (or `<key>~r`): empty. State stored before the option, under `<key>`, is no longer read |
| bump `version`                                  | the new key: empty. The previous version's slot stays in its entries, unread                       |
| roll back to the previous release               | that release's own key, including whatever it stored there before the upgrade                      |
| roll back to a release older than these options | `<key>`, as always. It never sees a suffixed slot                                                  |
| remove `version` (or `clearOnReload`)           | `<key>` again, including values from before the option was added if their entries still exist      |

The last row is the one to know: removing `version` is not a reset. To drop
state, bump the version.

### clearOnReload: state the server did not render with

Location state lives in the browser, so the server renders a document without
it. `useLocationState` therefore hydrates as `undefined` and applies the stored
value right after. For most state that is invisible. For state that decides
how much content is on the page, it is a layout shift on every refresh.

The case this option exists for is a "load more" list. `?page=6` loads that
page's 50 products through a loader, and the 250 already on screen ride along
as location state on the link, so the next page shows them at once and
streams the new ones:

```ts
// location-states.ts
import { createLocationState } from "@rangojs/router";

export const CarriedProducts = createLocationState<Product[]>({
  clearOnReload: true,
});
```

```tsx
"use client";
import { Link, useLoader, useLocationState } from "@rangojs/router/client";
import { ProductsLoader } from "./loaders"; // the page named by ?page
import { CarriedProducts } from "./location-states";

export function ProductList() {
  const { data } = useLoader(ProductsLoader);
  const carried = useLocationState(CarriedProducts) ?? [];
  const carriedIds = new Set(carried.map((product) => product.id));
  const products = [
    ...carried,
    ...data.products.filter((product) => !carriedIds.has(product.id)),
  ];

  return (
    <>
      <ul>
        {products.map((product) => (
          <li key={product.id}>{product.name}</li>
        ))}
      </ul>
      <Link
        to={`/products?page=${data.page + 1}`}
        state={[CarriedProducts(products)]}
        scroll={false}
      >
        Load more
      </Link>
    </>
  );
}
```

The `carriedIds` filter is a workaround, not part of the pattern. Today a
navigation applies the destination entry's location state to a mounted reader
as soon as the entry is pushed, before the destination's loader data commits,
so until that data lands `carried` already contains the page still on screen.
This is a known router ordering defect; once location state commits together
with the page it belongs to, the filter is unnecessary.

Without the option, a refresh of `?page=6` renders 50 products on the server
and then inserts the stored 250 above them. With it, the refreshed page stays
as the server rendered it:

| What happens to the entry                                                 | A `clearOnReload` slot                                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| The reader mounts during a client navigation (`<Link>`, `router.push`)    | applied, as without the option                                       |
| back/forward inside the running app (popstate), a server action's state   | applied, as without the option                                       |
| A document load: refresh, or a back/forward that loads the document       | not applied, and removed from `history.state`                        |
| Later on that page: a reader mounts, or a navigation returns to the entry | still `undefined`; the next write (the next "Load more") stores anew |
| The page is restored from the browser's back/forward cache                | untouched: nothing is loaded or hydrated                             |

- The rule is any document load of the entry, not only the Reload button:
  restoring a closed tab or duplicating a tab loads the document too.
- Only the entry being loaded is cleared. Going back from it to an earlier
  entry inside the running app is a client navigation and applies that
  entry's state.
- The router removes every `~r` key when the client starts, before hydration.
  It goes by the key alone, so it does not matter whether a reader is mounted,
  where it sits (a `<Suspense>` boundary that hydrates late included), or
  whether the definition's module is loaded at all. Other slots on the entry
  are left alone.
- State the server sets is never dropped by this: a document response carries
  no location state, and `ctx.setLocationState()` / `redirect(url, { state })`
  reach `history.state` only through navigations and actions in the running
  app, after start-up.
- `.write()` stores under the same key, so it does not survive a refresh
  either.
- Adding the option to an existing definition moves it to the `~r` key: state
  stored before, under the plain key, is no longer read (and is not removed).
  Removing the option moves it back to the plain key; what was stored under
  `~r` is removed at the next document load.
- Combine it with `version` and `validate` freely. It cannot be combined with
  `flash`: flash state is removed at its first read, so the pair could only
  drop a message nobody has seen yet.

### .read() (non-hook access)

Read current location state outside React components (client-side only):

```tsx
import { FlashMessage, ProductState } from "../location-states";

// Returns TState | undefined. Returns undefined during SSR.
const flash = FlashMessage.read();
const product = ProductState.read();
```

`.read(location)` reads this definition's slot from any `{ state }` snapshot
instead of the current entry, such as the `from` / `to` of a
`transition({ when })` context. It works without `window` and never clears
flash state:

```tsx
transition({ when: ({ to }) => ProductState.read(to) !== undefined });
```

> **Hydration:** `.read()` returns `undefined` on the server but may return
> a real value on the first client render (history state survives reload).
> Do not call `.read()` directly during the initial render of a component;
> call it from an event handler or inside a `useEffect` post-mount. For
> reactive hydration-safe access, use `useLocationState()` instead.

### .write() / .delete() (static, non-reactive)

Static counterparts to `.read()`. Both mutate the current history entry's
`history.state` via `replaceState`, preserving any other keys (router
bookkeeping, other location state slots). Both are client-only; they throw
when called on the server.

Neither dispatches an event, so components reading via `useLocationState`
will NOT re-render until the next navigation/popstate. Pair with `.read()`
(or a fresh mount via back/forward/reload) instead.

```tsx
"use client";
import { ProductState } from "./state";

// Persisted across hard refresh and back/forward of this entry.
ProductState.write({ name: "Widget", price: 9.99 });

// Read later (or on next mount).
const current = ProductState.read();

// Manually clear the slot. Idempotent if it isn't set.
ProductState.delete();
```

| Method            | Updates `history.state` | Fires `useLocationState` rerender | SSR behavior        |
| ----------------- | ----------------------- | --------------------------------- | ------------------- |
| `.read()`         | no                      | n/a (returns snapshot)            | returns `undefined` |
| `.read(location)` | no                      | n/a (reads the given snapshot)    | reads the snapshot  |
| `.write()`        | yes (replace this slot) | no                                | throws              |
| `.delete()`       | yes (remove this slot)  | no                                | throws              |

## Cache Control

### invalidateClientCache()

Force the client's caches to miss after a mutation the router can't see (a REST
call, a WebSocket push, a login). It is a plain function, not a hook, so it works
from module-level callbacks too. Imported from the root entry `@rangojs/router`,
it is selected by export conditions:

- **Client** (client component or module): marks the history cache stale,
  flushes the prefetch cache, rotates the router state, and notifies other tabs
  — the same thing a completed server action does. During SSR of a client
  component it is a no-op (dev warning).
- **Server** (handler, server component, middleware, loader, or action): writes
  a rotated state `Set-Cookie` for the responding client, which marks its
  caches stale when it next reads them. Idempotent within a request; throws
  inside a `cache()` / `"use cache"` boundary; a no-op with a dev warning
  outside a request. On a `ppr` route a shell HIT runs no handler, so a call
  from handler code writes the cookie only on the renders that run it (a
  MISS); call it from middleware, which runs on every request, HITs included.

Server actions already invalidate automatically; to suppress that for a no-op
action, call `keepClientCache()` inside it (see `/server-actions` → "Client
Cache After an Action").

```tsx
"use client";
import { invalidateClientCache } from "@rangojs/router";

function SaveButton() {
  const handleSave = async () => {
    await fetch("/api/data", {
      method: "POST",
      body: JSON.stringify(data),
    });

    // Invalidate the client's caches after the mutation
    invalidateClientCache();
  };

  return <button onClick={handleSave}>Save</button>;
}
```

A module-level subscription works the same way (no component needed):

```ts
import { invalidateClientCache } from "@rangojs/router";

socket.on("catalog-updated", () => invalidateClientCache());
```

**Use cases**: REST API mutations, WebSocket updates, non-RSC data changes.
