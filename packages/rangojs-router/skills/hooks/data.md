# Data Hooks

### useLoader()

Access loader data (strict — data guaranteed once the read returns):

```tsx
"use client";
import { useLoader } from "@rangojs/router/client";
import { ProductLoader } from "../loaders/product";

function ProductPrice() {
  const { data, isLoading, error } = useLoader(ProductLoader);

  // data: T (guaranteed - throws if not in context)
  // isLoading: boolean (refetch/load() states — NOT the initial streamed read)
  // error: Error | null

  return <span>${data.price}</span>;
}
```

**Loaders stream, and `useLoader` implicitly suspends.** A first read whose
loader data has not streamed in yet suspends to the nearest `<Suspense>`
boundary (or the route's `loading()`) — it does NOT render with
`isLoading: true`. Put a boundary above every read whose loader can be slow;
`isLoading` covers later refetches (`load()`, key/group refreshes). Once the
component renders, `data` is present. (On document loads a loader registered
with `{ stream: "navigation" }` is already settled at first paint, so its
reads never suspend there — see `/loader`.)

**Precondition**: Loader must be registered on route via `loader()` helper.

Loaders can also be passed as props from server to client components:

```tsx
"use client";
import { useLoader } from "@rangojs/router/client";
import type { ProductLoader } from "../loaders";

// typeof infers the full data type from the loader definition
function ProductCard({ loader }: { loader: typeof ProductLoader }) {
  const { data } = useLoader(loader);
  return <h2>{data.product.name}</h2>;
}
```

### useFetchLoader()

Access loader with on-demand fetching (flexible):

```tsx
"use client";
import { useFetchLoader } from "@rangojs/router/client";
import { SearchLoader } from "../loaders/search";

function SearchResults() {
  const { data, load, isLoading, error } = useFetchLoader(SearchLoader);

  // data: T | undefined (may be undefined if not fetched)
  // load: (options?) => Promise<T>
  // refetch: alias for load

  const handleSearch = async (query: string) => {
    await load({ params: { query } });
  };

  return (
    <div>
      <input onChange={(e) => handleSearch(e.target.value)} />
      {isLoading && <Spinner />}
      {data?.results.map((r) => (
        <Result key={r.id} {...r} />
      ))}
    </div>
  );
}
```

**Shared refetch behavior**:

When the loader is registered on the route via `loader()`, a plain
`load()` call (no options, or a trivially-defaulted GET with no
`params` and no `body`) broadcasts its result to every component
reading the same loader id. Layout, page, and parallel-slot reads
all converge on the new value:

```tsx
// Layout button calls load() — the page read below sees the update too.
function Layout() {
  const { data, load } = useLoader(CartLoader);
  return <button onClick={() => load()}>Refresh ({data.count})</button>;
}
function Page() {
  const { data } = useLoader(CartLoader); // updates with the layout's load()
  return <span>{data.count} items</span>;
}
```

`isLoading` and `error` follow the same scope. `throwOnError: true`
render-throws are scoped to the **originating** hook — sibling readers
see the error in their `error` state but their boundaries are not
triggered by someone else's failure. A successful follow-up `load()`
clears the shared error.

**`load()` calls that stay local** (no broadcast, per-hook state, same
semantics as the old per-component `useState`):

- `load({ params: { ... } })` — explicit params.
- `load({ method: "POST", body })` — mutations.
- Any `load()` on a `useFetchLoader(loader)` whose loader is **not**
  registered on the current route. Two unrelated components calling
  `load()` on the same fetchable-but-unregistered loader keep
  independent results.

So the search/list pattern still works — two components calling
`load({ params: { q } })` with different `q` values each keep their
own result; they do not collapse to last-write-wins through a shared
store.

**Scoping refetch with a `key`**:

Pass a `key` to partition the shared refresh store. Only hooks using the
**same** `key` refresh together when one of them calls `load()`. This is a
client-side refresh identity only — it never changes the request sent to the
server, and is unrelated to the server `cache({ key })` option and to
`revalidate()`.

```tsx
// Two independent dashboards using the same loader. Without a key, one
// dashboard's load() would flip the other's spinner and value. With a key,
// they refresh independently.
function Dashboard({ id }: { id: string }) {
  const { data, load } = useLoader(StatsLoader, { key: `dashboard:${id}` });
  return <button onClick={() => load()}>Refresh {data.total}</button>;
}
```

The `key` widens sharing in two ways the default cannot:

- **Parameterized GETs share.** `useFetchLoader(SearchLoader, { key: q })`
  with the same `q` in two components share one result and refresh together —
  a keyed `load({ params: { q } })` broadcasts to the group instead of staying
  local. (Mutations — non-GET or `body` — stay local even with a key.)
- **Unregistered loaders share.** A `key` makes `useFetchLoader` of a loader
  that is **not** registered on the route share too, letting unrelated
  components opt into a common refresh group.

Lifecycle: a keyed read of an unregistered loader is reference-counted — its
shared value lives as long as at least one component using that key is mounted.
A persistent component (e.g. a header) keeps the value across navigations; a
route-scoped component's value is reclaimed when it unmounts. Registered-loader
reads (keyed or not) reset on navigation from fresh route data, as before.

**Refreshing multiple loaders together (`refreshGroup` + `useRefreshLoaders`)**:

`key` groups readers of one loader. To refresh **different** loaders together,
tag them with a shared `refreshGroup` name and trigger them with
`useRefreshLoaders()`. The hook takes no argument; you pass the group(s) to the
function it returns, so one `useRefreshLoaders()` can refresh different groups
depending on context. A read may carry **several** tags — pass an array — and is
refreshed when **any** of its groups is refreshed:

```tsx
function Profile() {
  const { data } = useLoader(ProfileLoader, {
    key: userId,
    refreshGroup: "account",
  });
  return <span>{data.name}</span>;
}
function Orders() {
  // Tagged into two groups: refreshed by "account" (the whole set) or the
  // finer "orders" tag.
  const { data } = useLoader(OrdersLoader, {
    key: userId,
    refreshGroup: ["account", "orders"],
  });
  return <span>{data.count} orders</span>;
}
function RefreshButtons() {
  const refresh = useRefreshLoaders();
  return (
    <>
      <button onClick={() => refresh("account")}>Refresh account</button>
      <button onClick={() => refresh("orders")}>Refresh orders only</button>
      <button onClick={() => refresh(["account", "orders"])}>
        Refresh both
      </button>
    </>
  );
}
```

`refresh(groups)` accepts one name or an array and re-runs every currently-mounted
member tagged with **any** of them, with a **plain GET** against the current route
URL — no params, no body, no mutation methods, because a group spans loaders with
different shapes. A member that sits in two of the requested groups is fetched
once (members are unioned and deduped by read). It returns a promise that resolves
when all members settle and **rejects with an `AggregateError`** if any fail;
group refresh never render-throws, so handle failures at the await site
(`await refresh("account").catch(...)`). Each failing member also exposes its
error via its own read's `error`.

Multiple tags give you granular vs. whole-set refresh from one place: a coarse
tag (`"account"`) covers everything, while a finer tag (`"orders"`) targets a
subset. Sharing within a group is opt-in via `key`: members that share a `key`
share one value (and one fetch); a grouped reader **without** a `key` gets its own
private bucket, so a group refresh updates only that read and never leaks into
unrelated unkeyed reads of the same loader. A bucket may belong to several groups
at once (one read tagged with multiple names, or different reads tagging the same
keyed bucket with different names). Keep parameterized loaders on the single-loader
`key` — a plain-GET group refresh sends no params.

**Load options**:

```tsx
// JSON body — sent as application/json, available as ctx.body on the server
await load({
  method: "POST",
  params: { query: "test" },
  body: { data: "value" },
});

// FormData body — sent as multipart/form-data, available as ctx.formData on the server.
// Automatically detected: when body is a FormData instance, the request switches
// to multipart/form-data to preserve File objects and binary data.
const formData = new FormData();
formData.append("file", fileInput.files[0]);
await load({ method: "POST", body: formData });
```

**Body type auto-switching**: The `load()` function inspects the `body` value to
choose the encoding. If `body instanceof FormData`, the request is sent as
`multipart/form-data` (browser sets the boundary header automatically). Otherwise
the body is JSON-serialized and sent with `Content-Type: application/json`. On the
server, JSON bodies are available via `ctx.body` and FormData bodies via `ctx.formData`.

**File upload example**:

```tsx
"use client";
import { useFetchLoader } from "@rangojs/router/client";
import { FileUploadLoader } from "../loaders/upload";

function FileUploader() {
  const { data, load, isLoading } = useFetchLoader(FileUploadLoader);
  const formRef = useRef<HTMLFormElement>(null);

  const handleSubmit = async (formData: FormData) => {
    await load({ method: "POST", body: formData });
    formRef.current?.reset();
  };

  return (
    <form ref={formRef} action={handleSubmit}>
      <input type="file" name="file" />
      <button type="submit" disabled={isLoading}>
        {isLoading ? "Uploading..." : "Upload"}
      </button>
      {data?.uploadedFile && <p>Uploaded: {data.uploadedFile.name}</p>}
    </form>
  );
}
```

Server-side loader for the upload:

```typescript
import { createLoader } from "@rangojs/router";

export const FileUploadLoader = createLoader(async (ctx) => {
  "use server";

  const file = ctx.formData?.get("file") as File | null;
  if (file && file.size > 0) {
    // Process file (save to R2, D1, etc.)
    return { uploadedFile: { name: file.name, size: file.size } };
  }
  return { uploadedFile: null };
}, true); // true = fetchable (can be called from the client via load())
```
