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

Or via `ctx.setLocationState()` on any response (handlers and middleware):

```tsx
(ctx) => {
  ctx.setLocationState(FlashMessage({ text: "Welcome back!" }));
  return <Dashboard />;
};
```

### Version and validate

The slot key is the file path plus the export name, so it stays the same across
deploys. History entries survive reloads and back/forward. A tab left open
across a release that changed the shape would otherwise restore the old value
typed as the new one.

`version` is the cheap check for a deliberate shape change. Writers store
`{ v, value }`. A missing `v`, a different `v`, or a non-object reads as
`undefined` — the same as no state. A pre-version raw object is not treated as
the new state. The value you get back is the inner `value`, the same reference
that was stored.

```ts
export const GridState = createLocationState<GridSnapshot>({ version: 2 });
// stored as { v: 2, value }; a different or missing version reads as undefined
```

`validate` also covers state written by other code under the same key. The
stored shape stays the raw value. The check runs on read; `false` reads as
`undefined`.

```ts
export const GridState = createLocationState<GridSnapshot>({
  validate: (value): value is GridSnapshot => isGridSnapshot(value),
});
// run on read; a failing value reads as undefined
```

Both may be set. A version mismatch returns `undefined` without calling
`validate`. A match runs `validate` on the inner value. `flash: true` still
clears the slot after paint; when `version` is set the slot holds the envelope
and readers still see `TState | undefined`.

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
