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

### When a reader sees an entry's state

A reader sees a history entry's location state together with that entry's
page, never before it. The router keeps the state of the entry on screen next
to the page it renders and changes both in one React commit. While a
navigation is pending (its loader still streaming, a `transition()` holding
the page) what is on screen keeps the state of the entry being left. That
holds for every reader in it, including one that mounts during the wait: it
reads the entry on screen, not the one `history.state` already holds.
Back/forward and state the server sets on a navigation
(`ctx.setLocationState()`, `redirect(url, { state })`) follow the same rule.

| What changes the state                                       | A reader gets it                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `<Link state>`, `router.push()` / `router.replace()`         | in the commit that shows the destination                         |
| back/forward                                                 | in the commit that restores the entry (cached or refetched)      |
| the server, on a navigation (`setLocationState`, a redirect) | in the commit that shows the destination                         |
| the server, on a document load (a page load, a no-JS post)   | once the page has hydrated, as stored state                      |
| a navigation the server answers with nothing to re-render    | with the new location: the page on screen is the entry's         |
| `router.push(url, { revalidate: false })` (no server fetch)  | with the new location: the page does not change                  |
| a server action's `setLocationState` (no navigation)         | when the action's response arrives, added to what readers show   |
| `Def.write()` / `Def.delete()`                               | when the entry is next restored: back/forward to it, or a reload |

Three consequences:

- A value keeps its identity until the entry's state changes it. A navigation
  that carries no state re-renders no reader. One that does re-renders each
  reader once, in the commit that already renders the page; a reader of a
  slot the navigation carried forward unchanged (the value it got from the
  hook, passed back) or of a slot a server action did not touch gets the same
  object again, so its effects and memoized children do not run. Any other
  object is a new value, equal content included: a link clicked twice
  announces its state twice. A value is always a copy of what was passed.
- `Def.write()` and `Def.delete()` change the history entry and nothing a
  reader shows, whether it is mounted or mounts later. `Def.read()` returns
  the written value at once.
- Outside the router's provider (a second React root, a component rendered
  bare in a test) a reader has no entry and returns `undefined`. Test with
  `renderRoute` (see `/testing`).

A reader that mounts with the destination reads the destination's state on
its first render. Inside an optimistically rendered `clientUrls()` destination
that is the state the navigation carries, before the server has answered (see
`/client-urls`, "Pitfalls").

The URL hooks follow the same rule for a component that is mounted across the
navigation: on back/forward too, `usePathname()` and `useSearchParams()`
change with the page, not at the `popstate` event (see
[`./urls.md`](./urls.md), "When the URL hooks change"). One difference
is by design (issue #1046): a component that first mounts in the page being
left, after the response arrived and while React still holds the destination,
reads its own entry's location state from `useLocationState` and the
destination's URL and params from `usePathname()`, `useSearchParams()` and
`useParams()`. Components already on screen keep the page on screen's values
until the destination commits.

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
hook reads it. `useLocationState` reads the value during render (on a
document load it returns `undefined` until the document has finished streaming
and hydrating, so SSR and hydration agree), then clears it from `history.state` via
`replaceState` in a `useEffect`. Every component reading the same flash
definition sees the value, whenever it mounts, until the next navigation or
back/forward commits its entry's state: an entry that carries no flash shows
none. A server action's state does not end it. Pressing back/forward will not
re-show the flash since it was cleared.

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
with a client navigation's or an action's response, and with a document
response too (see "State on a document response" below):

```tsx
(ctx) => {
  ctx.setLocationState(FlashMessage({ text: "Welcome back!" }));
  return <Dashboard />;
};
```

### Several writes to one definition

Entries accumulate across definitions, but one definition is one slot in
`history.state`: for the same definition the last write wins. Two
`ctx.setLocationState(Toasts(...))` calls in one response, or
`redirect(url, { state: [Toasts(a), Toasts(b)] })`, deliver only the later
value, without a warning. A server action, a handler and the middleware
around them all write to the same response, so a shared helper that writes a
definition replaces what an earlier call wrote.

To combine several messages, make the state an array and write it once, for
example by collecting them in a request variable and writing the definition
at the end of the action:

```ts
export const Toasts = createLocationState<ToastMessage[]>({ flash: true });

// One write per response, with every toast in it.
getRequestContext().setLocationState(Toasts([...savedToasts, loginToast]));
```

### State on a document response

A document request has no history entry yet, so the router carries what the
server set to the client and writes it there when the client starts. This
covers the mutations that most need a flash message: a `<form action={fn}>`
posted before hydration or without JS, a payment provider redirecting the
shopper back, a link from an email.

| The document request                                                         | Where the state travels                                          |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| renders a page (`setLocationState` in a handler, middleware or no-JS action) | the document's bootstrap payload                                 |
| redirects (`redirect(url, { state })`, or `setLocationState` and a redirect) | a one-shot cookie the target's document request reads and clears |
| redirects with `{ external: true }` or off-origin                            | nowhere: the cookie would not reach the target                   |

```tsx
// A payment provider sends the shopper back to /checkout/callback.
path("/checkout/callback", async (ctx) => {
  const ok = await completeOrder(ctx.searchParams.get("token"));
  return ok
    ? redirect("/orders/confirmed", { state: [Flash({ text: "Paid" })] })
    : redirect("/checkout", { state: [Flash({ text: "Payment declined" })] });
});
```

- **When a reader gets it.** `useLocationState` returns `undefined` while the
  document streams and hydrates, then the value, at the moment it would get
  state stored in the entry. A flash message shows just after hydration.
- **Without JS, no flash.** The state rides to the client, and only the
  client writes it into the entry and hands it to readers. A visitor with JS
  disabled gets the page as the server rendered it, where every reader of the
  state shows `undefined`: the post and its redirect work, but the message
  never shows. If such visitors must see it, render it from the server, for
  example from a search param or a cookie your handler reads.
- **Flash and refresh.** Flash state is cleared once read, as always. The
  cookie is cleared by the response that read it, so a refresh of the target
  renders without it. A page whose handler sets state on every request
  delivers it again on a refresh, because the handler ran again. A no-JS post
  answered with a page (no redirect) is re-posted by the browser on refresh;
  redirect after the post (`redirect(url, { status: 303, state })`) to avoid
  that.
- **Caching.** A document that carries state, and the redirect carrying it
  on, are sent `Cache-Control: private, no-store`, after every middleware.
  The document cache neither stores such a document nor answers a request
  that arrives with the cookie from a stored one. A shared PPR shell never
  holds state: on a `ppr` route, state set before the render (by middleware,
  or the cookie) rides the live payload of a shell HIT or MISS, and the shell
  is still served and captured; state a handler sets keeps that route from
  being captured, so it renders in full. `no-store` also keeps the
  page out of the browser's back/forward cache (Chrome's bfcache), so Back to
  it loads it again. That costs little for a one-off flash; a handler that
  sets state on every request pays it on every page view.
- **`ppr` and cached routes.** A shell HIT and a `cache()` hit run no
  handler, so a handler there cannot set state on that request. Set it from
  middleware, which runs on every request; the HIT still serves, with the
  state in its live payload. A HIT sends exactly the state set before its
  render: its headers leave before its tail runs, so they decide then
  whether the response is private.
- **Not from a loader.** A loader has no `setLocationState`, and calling
  `getRequestContext().setLocationState()` from one is not supported: the
  payload takes the request's state before loaders settle, so a loader's
  write may arrive (a `ppr` MISS then renders in full) or be dropped, and a
  shell HIT never sends it. Set state from middleware, the handler or an
  action.
- **The cookie.** It is named after the router's state cookie
  (`<stateCookieName>-ls`, `__Host-` prefixed on https), `HttpOnly`,
  `SameSite=Lax`, `Path=/`, and lives 60 seconds. Only the next GET document
  request of the redirect's target pathname that navigates reads it: where
  the browser sends `Sec-Fetch-Dest`, it must be `document`, `iframe` or
  `frame`, so a `<link rel=prefetch>` or a `fetch()` of that path leaves it
  to the navigation. A form POST to it, a client navigation and a Flight
  fetch leave it too, as does a request of another path. A
  target that redirects again carries the state on to the next target. There
  is one such cookie per router: two document redirects within a moment (two
  tabs) keep only the later one's state. Without https there is no `__Host-`
  prefix, so a sibling subdomain could set the cookie: treat state that
  arrives this way as a message to show, not as a fact to act on. A `ppr`
  shell HIT that read the cookie and then cannot finish its tail reloads the
  page into a full render; its headers already cleared the cookie, so its
  reload script sets it again first (from script, so without `HttpOnly`,
  for the moment the reload takes), and the reload shows the state.
- **Known limit: a redirect from one router to another.** The cookie is
  named after the redirecting router's state cookie, which holds its router
  id (`<stateCookiePrefix>_<routerId>`), and a router reads only its own. On
  one origin served by several routers (a host router, or several
  `createRouter()` apps behind one worker), a document redirect from one
  router to a path another serves loses its state, without a warning. Carry
  such a message another way, such as a search param.
- **JSON only across a redirect.** The cookie holds JSON: a `Date` arrives as
  a string, a `Map` or `Set` as `{}`, `undefined` is dropped. Development
  warns, naming the slot. A value JSON cannot encode (a `bigint`), or state
  over the cookie's 4000-byte limit, is dropped from the redirect with a
  `console.warn`. Carry an id and load the rest on the target page.
  Navigation and action payloads are not limited this way.

### State from another deploy

History entries survive reloads and back/forward, so a tab left open across a
release still holds the state the older build wrote. The router drops it for
you: every entry records the app version its location state was written under,
and a read under any other version returns `undefined`, for typed slots and
for plain state alike. You do not manage a version and there is none to read;
the app version is the one the router already uses to reload a client that is
behind the server. It is computed from the app's built code (its server code
and the client assets), so it changes with a build that changes the app and
stays the same across a rebuild or redeploy of unchanged code.

| An entry's location state, read by                               | Result      |
| ---------------------------------------------------------------- | ----------- |
| the version that wrote it: navigation, back/forward, refresh     | the value   |
| the same code rebuilt or redeployed                              | the value   |
| a changed build, after a refresh or a restored tab               | `undefined` |
| a changed build, on back/forward to an entry the older one wrote | `undefined` |
| any build, when the entry predates this behavior                 | `undefined` |

So location state is for the current session of the current version of the
app: a filter carried on a link, a flash message, a scroll target. State that
has to outlive a deploy that changes the app belongs in the URL, a cookie or
storage. In development a
server-module edit (HMR) changes the version too; the running page keeps its
state, and the next document load drops it.

### createLocationState options

```ts
createLocationState<TState>({
  flash?: boolean, // read once, cleared after paint (above)
  clearOnReload?: boolean, // drop the state on a document load (below)
});
```

The value is always stored as-is. `clearOnReload` changes the slot's KEY in
`history.state` instead, by a suffix on the key the Vite plugin injects
(`<key>` below, `__rsc_ls_<file>#<ExportName>`):

| Options         | Key in `history.state` | Reads `undefined` when                          |
| --------------- | ---------------------- | ----------------------------------------------- |
| none, `flash`   | `<key>`                | the slot is empty (`flash`: once read)          |
| `clearOnReload` | `<key>~r`              | the entry's document was loaded since the write |

`Def.__rsc_ls_key` is that key, suffix included. `~` cannot appear in an export
name, so no other definition can end up with a suffixed key.

`flash` with `clearOnReload` is rejected: `createLocationState` throws in
development.

### clearOnReload: state the server did not render with

Location state lives in the browser, so the server renders a document without
it. `useLocationState` therefore hydrates as `undefined` and applies the stored
value once the document has finished streaming and every boundary has
hydrated. For most state that is invisible. For state that decides
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
  const products = [...carried, ...data.products];

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

The list is a plain concatenation. After "Load more" the next page's loader
streams while the current page stays on screen, and `carried` stays the
current entry's until that page lands: the carried products and the loader's
page change in one commit, so no product is ever listed twice.

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
- State the server sets is never dropped by this: the state a document
  response carries is written after the `~r` keys are removed, so a
  `clearOnReload` slot the server set for this load is applied on this load
  (and removed by the next one). Navigations and actions write after start-up.
- `.write()` stores under the same key, so it does not survive a refresh
  either.
- Adding the option to an existing definition moves it to the `~r` key: state
  stored before, under the plain key, is no longer read (and is not removed).
  Removing the option moves it back to the plain key; what was stored under
  `~r` is removed at the next document load.
- It cannot be combined with `flash`: flash state is removed at its first
  read, so the pair could only drop a message nobody has seen yet.

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

Neither changes what a `useLocationState` reader shows, mounted or mounting
later: readers get the entry's state as it was committed (see "When a reader
sees an entry's state"). The written value is there for `.read()` at once,
and for readers when the entry is next restored (back/forward to it, or a
reload).

```tsx
"use client";
import { ProductState } from "./state";

// Persisted across hard refresh and back/forward of this entry.
ProductState.write({ name: "Widget", price: 9.99 });

// Read later.
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
  flushes the prefetch cache, rotates the router state, and notifies other
  tabs, which adopt the new state and flush theirs. That is more than a
  completed server action does: an action marks history and prefetches stale
  and rotates nothing (its response bumps only the state's write part, so the
  browser HTTP cache misses on responses from before the write). During SSR
  of a client component it is a no-op (dev warning).
- **Server** (handler, server component, middleware, loader, or action): writes
  a rotated state `Set-Cookie` for the responding client, which marks its
  caches stale when it next reads them. Idempotent within a request; throws
  inside a `cache()` / `"use cache"` boundary; a no-op with a dev warning
  outside a request. On a `ppr` route a shell HIT runs no handler, so a call
  from handler code writes the cookie only on the renders that run it (a
  MISS); call it from middleware, which runs on every request, HITs included.

Server actions already mark the caches stale automatically; to suppress that
for a no-op action, call `keepClientCache()` inside it, and for the full flush
and rotation, call `invalidateClientCache()` inside it (see `/server-actions` →
"Client Cache After an Action").

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
