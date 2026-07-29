# Data Fetching and Actions

## 3. Data Fetching

### Loaders → handler (the default migration)

In React Router, loaders and components are separate: the loader fetches data,
the component renders it via `useLoaderData()`. In Rango, server component
handlers do both — combine the loader and component into a single handler:

```typescript
// React Router: separate loader + component
export async function loader({ params }) {
  const product = await getProduct(params.slug);
  return { product };
}
function ProductPage() {
  const { product } = useLoaderData();
  return <div>{product.name}</div>;
}

// Rango: handler fetches and renders directly
const ProductPage: Handler<"product"> = async (ctx) => {
  const product = await getProduct(ctx.params.slug);
  return <div>{product.name}</div>;
};
```

This is the standard migration path. The handler IS the loader — it fetches
data, then returns JSX. No separate data-fetching layer needed.

### When to use createLoader()

Rango's `createLoader()` is a live data layer, not a loader migration target.
Use it only when you need capabilities beyond what the handler provides:

- **Client-side reactive data** — `useLoader()` in client components for data
  that updates without a full page navigation
- **Shared data across segments** — a loader registered on a layout is available
  to all child routes via `ctx.use(Loader)` or `useLoader(Loader)`
- **Independent revalidation** — `revalidate()` on a specific loader after actions
- **Per-loader caching** — `loader(L, () => [cache({ ttl: 60 })])`
- **RR-loader-shaped authority** — a loader that `throw redirect(...)`s or
  throws a 404 keeps that shape: Rango loaders throw `redirect()`/`notFound()`
  too (one caveat: a Rango loader redirect is a client-side navigate on
  document loads, never an HTTP 302 — pre-stream 302s move to middleware)
- **`meta({ data })` / `handle` exports** — data-derived page metadata becomes
  a handle push from the loader body (`ctx.use(Meta)({ title: data.name })`),
  with `loader(L, { ssr: false })` when it must be in the SSR'd head

If the React Router loader just fetches data for its page component AND the
component can become a server component, merge it into the handler. If the
component stays a client component, port the whole group with `clientUrls()`
instead — loader, `useLoader` read, and browser-run `revalidate()` keep the RR
route-module shape (see the "Two target shapes" section in the main skill and
`/client-urls`). See `/loader` for when the live data layer is useful.

### Actions

React Router form actions map to Rango server actions:

```typescript
// React Router:
export async function action({ request }) {
  const formData = await request.formData();
  await updateUser(formData.get("name"));
  return redirect("/profile");
}
function EditProfile() {
  return (
    <Form method="post">
      <input name="name" />
      <button type="submit">Save</button>
    </Form>
  );
}

// Rango: "use server" action + native form or useActionState
"use server";
import { redirect } from "@rangojs/router";

export async function updateProfile(formData: FormData): Promise<void> {
  await updateUser(formData.get("name") as string);
  throw redirect("/profile");
}

// Client component:
function EditProfile() {
  return (
    <form action={updateProfile}>
      <input name="name" />
      <button type="submit">Save</button>
    </form>
  );
}
```

Key difference: React Router actions are route-scoped (declared per route).
Rango actions are function-scoped (`"use server"` on any exported async function).

### useLoaderData

There is no `useLoaderData()` in Rango. For most cases, the handler fetches
and renders directly (see above). When a client component needs live reactive
data, use `createLoader()` + `useLoader()`:

```typescript
// React Router: useLoaderData() in client component
function ProductPrice() {
  const { price } = useLoaderData();
  return <span>{price}</span>;
}

// Rango: useLoader() reads from a registered loader (live data layer)
"use client";
import { useLoader } from "@rangojs/router/client";
import { PriceLoader } from "../loaders";

function ProductPrice() {
  const { data } = useLoader(PriceLoader);
  return <span>{data.price}</span>;
}
```

`useLoader()` provides live data that stays fresh — it re-fetches on navigation
and after actions (controlled by `revalidate()`). This is different from
`useLoaderData()` which just reads a snapshot.

### useActionData

React Router's `useActionData()` reads the return value of a route-scoped
`action()`. In Rango, actions are standard React server actions (`"use server"`),
so all React patterns apply directly:

```typescript
// React Router:
export async function action({ request }) {
  const form = await request.formData();
  const errors = validate(form);
  if (errors) return { errors };
  await save(form);
  return { ok: true };
}
function EditForm() {
  const data = useActionData();
  return (
    <Form method="post">
      {data?.errors && <p>{data.errors}</p>}
      <input name="title" />
      <button>Save</button>
    </Form>
  );
}

// Rango: useActionState (standard React hook)
"use client";
import { useActionState } from "react";
import { saveForm } from "../actions"; // "use server" function

function EditForm() {
  const [state, action, pending] = useActionState(saveForm, null);
  return (
    <form action={action}>
      {state?.errors && <p>{state.errors}</p>}
      <input name="title" />
      <button disabled={pending}>Save</button>
    </form>
  );
}
```

Since Rango uses RSC server actions, all React action patterns work:
`useActionState`, `useOptimistic`, `useTransition`, `startTransition`,
and plain `<form action={serverAction}>`. No framework-specific hook needed.

For the full guide — defining actions, validation with Zod, error handling,
revalidation rules, file uploads, and progressive enhancement — see
`/server-actions`.

### clientLoader / clientAction (framework mode)

RR7 framework mode's `clientLoader` and `clientAction` run in the browser.
Rango does not have a framework-level client loader/action concept — these
migrate to standard React client-side code:

```typescript
// RR7: clientLoader fetching from a third-party API
export async function clientLoader() {
  const res = await fetch("https://api.weather.com/current?city=london");
  return res.json();
}

// Rango: "use client" component with hooks
"use client";
import { useState, useEffect } from "react";

function WeatherWidget() {
  const [weather, setWeather] = useState(null);
  useEffect(() => {
    fetch("https://api.weather.com/current?city=london")
      .then((r) => r.json())
      .then(setWeather);
  }, []);
  if (!weather) return <span>Loading...</span>;
  return <span>{weather.temp}°C</span>;
}
```

The general rule: anything that ran in `clientLoader`/`clientAction` moves into
React hooks (`useState`, `useEffect`, `useActionState`, `useOptimistic`) inside
a `"use client"` component. There is no framework wrapper — it's just React.

### shouldRevalidate (framework mode)

RR7's `shouldRevalidate` export maps directly to Rango's `revalidate()` DSL:

```typescript
// RR7:
export function shouldRevalidate({ actionResult, currentParams, nextParams }) {
  if (actionResult) return true;
  return currentParams.slug !== nextParams.slug;
}

// Rango:
path("/product/:slug", ProductPage, { name: "product" }, () => [
  revalidate(({ actionId, currentParams, nextParams }) => {
    if (actionId) return true;
    return currentParams.slug !== nextParams.slug;
  }),
]);
```

Note: RR7's `shouldRevalidate` controls client-side loader re-fetching. Rango's
`revalidate()` controls which segments re-run during partial rendering after
navigation or actions. The intent is the same — skip unnecessary work — but
the mechanism is segment-level rather than loader-level.
