---
name: server-actions
description: Define and call server actions (`"use server"`) — forms, useActionState, useOptimistic, validation, error handling, redirects, post-action revalidation, and client-cache control (keepClientCache). Use when handling a form submission on the server, calling a server function from a client component, choosing what re-renders after a mutation, or needing optimistic UI after a mutation.
argument-hint: "[action]"
---

# Server Actions with `"use server"`

Server actions are async functions that run on the server and are callable from
the client. They are React's RSC mutation primitive — Rango uses them as-is
with no framework wrapper. All standard React hooks (`useActionState`,
`useFormStatus`, `useOptimistic`, `useTransition`) work directly.

This skill covers defining actions, calling them (with and without JavaScript),
validation, redirects, errors, authorization, what re-renders after an action,
and how the client cache reacts.

## When to Use Actions vs Loaders

| Need                               | Use                                          |
| ---------------------------------- | -------------------------------------------- |
| Mutate state and revalidate UI     | Server action                                |
| Read live data on every navigation | `createLoader()` + `useLoader()`             |
| Read on demand from the client     | Fetchable loader + `useFetchLoader()`        |
| Submit a form and show the result  | Action + `useActionState`                    |
| File upload                        | Action with `FormData` (or fetchable loader) |

Use loaders and route handlers for reads. Use actions for writes. After an
action runs, the matched route tree can partially re-render so handlers and
loaders that opt into revalidation see the new state — see "Revalidation"
below. For the read-side APIs (`createLoader`, `useLoader`, `useFetchLoader`),
see `/loader`.

## Revalidation Model

Actions mutate state; route handlers and loaders read the latest state. After
an action finishes, Rango performs a server-side revalidation render for the
matched route so the UI receives fresh segment output and loader data.

The main control point is `revalidate((ctx) => ...)` on the segment that owns
the data. Match specific actions by imported reference with `ctx.isAction()`;
use raw `actionId` only when you intentionally need path or directory matching.
This applies to `path()` handlers, `layout()` handlers, `parallel()` slots,
`intercept()` routes, and loader registrations:

```typescript
// urls.tsx — path/layout/parallel/intercept/loader/revalidate are passed in by urls()
import { urls } from "@rangojs/router";
import * as CartActions from "./actions/cart";

export const urlpatterns = urls(({ path, loader, revalidate }) => [
  // The loader belongs to the route that consumes its data — nest it inside
  // the owning path() so the segment owns its data dependency.
  path("/cart", CartPage, { name: "cart" }, () => [
    // The route and its loaders re-run after every action by default. Narrow
    // both to cart actions; on navigation, undefined keeps the default.
    revalidate((ctx) =>
      ctx.isAction() ? ctx.isAction(CartActions) : undefined,
    ),
    loader(CartLoader, () => [
      revalidate((ctx) =>
        ctx.isAction() ? ctx.isAction(CartActions) : undefined,
      ),
    ]),
  ]),
]);
```

`ctx.isAction()` resolves the imported action reference the same way the router
derives `actionId`, so it matches in both dev and production and survives action
renames/moves as type errors instead of silent substring drift.

For module-level `"use server"` files, the raw `actionId` passed to every
server-side `revalidate()` predicate is path-bearing in the server/RSC
environment in both dev and production: `src/actions/cart.ts#addToCart`. This is
the escape hatch for broad filters by action file, directory, or export name.

Actions and the follow-up revalidation render share one request context.
Values written in the action with `ctx.set(MyVar, value)` or `ctx.set("key",
value)` are visible to downstream route middleware, handlers, loaders, and
`revalidate()` callbacks through `context.get(MyVar)` / `context.get("key")`:

```typescript
// app/context.ts
import { createVar } from "@rangojs/router";

export const ChangedTenant = createVar<string>();
```

```typescript
// app/actions/tenant.ts
"use server";

import { getRequestContext } from "@rangojs/router";
import { ChangedTenant } from "../context";

export async function switchTenant(tenantId: string) {
  const ctx = getRequestContext();
  ctx.set(ChangedTenant, tenantId);
  await db.tenants.touch(tenantId);
}
```

```typescript
// urls.tsx
import { urls } from "@rangojs/router";
import * as TenantActions from "./actions/tenant";
import { ChangedTenant } from "./context";

export const urlpatterns = urls(({ path, revalidate }) => [
  path("/dashboard/:tenantId", DashboardPage, { name: "dashboard" }, () => [
    // The route re-runs after every action by default. Narrow it: after an
    // action, re-run only when a tenant action changed this tenant.
    revalidate((ctx) => {
      if (!ctx.isAction()) return undefined; // navigation: keep the default
      return (
        ctx.isAction(TenantActions) &&
        ctx.context.get(ChangedTenant) === ctx.context.params.tenantId
      );
    }),
  ]),
]);
```

Client and SSR-facing action references keep hashed IDs in production for
security and hydration compatibility. Do path matching inside server-side
`revalidate()` predicates, not from client action metadata. Inline actions
declared inside RSC components also keep hashed IDs; if you need path-based
revalidation, export the action from a module-level `"use server"` file.

## Defining an Action

Two equivalent patterns. Prefer the file-level form for anything reusable.

### File-level (`"use server"` at the top of a module)

Every exported async function becomes a callable server action.

```typescript
// app/actions/cart.ts
"use server";

import { cookies } from "@rangojs/router";

export async function addToCart(productId: string): Promise<void> {
  const userId = cookies().get("user-id")?.value;
  await db.cart.insert({ userId, productId });
}

export async function removeFromCart(productId: string): Promise<void> {
  const userId = cookies().get("user-id")?.value;
  await db.cart.delete({ userId, productId });
}

export async function updateQuantity(
  productId: string,
  delta: number,
): Promise<void> {
  const userId = cookies().get("user-id")?.value;
  await db.cart.adjust({ userId, productId, delta });
}
```

### Inline (`"use server"` inside a server component)

Define a one-off action where it is used. Captured variables are serialized,
so keep them small and serializable.

```tsx
// Server component (handler)
import type { Handler } from "@rangojs/router";

const SettingsPage: Handler<"settings"> = (ctx) => {
  const userId = ctx.get("user").id;

  async function updateName(formData: FormData) {
    "use server";
    await db.users.update(userId, { name: formData.get("name") as string });
  }

  return (
    <form action={updateName}>
      <input name="name" />
      <button type="submit">Save</button>
    </form>
  );
};
```

## Calling Actions from the Client

Three patterns, in order of how much state you need to preserve:

### 1. Plain `<form action={...}>` — fire-and-forget

Submits as `FormData`. Works without JavaScript (progressive enhancement).
The page revalidates after the action returns.

```tsx
"use client";
import { addToCart } from "../actions/cart";

export function AddToCartForm({ productId }: { productId: string }) {
  return (
    <form action={addToCart.bind(null, productId)}>
      <button type="submit">Add to cart</button>
    </form>
  );
}
```

### 2. `useActionState` — preserve return value + pending state

Standard React 19 hook. The action receives `(prevState, formData)` and its
return value becomes the new `state`. To keep what the user typed after a
validation error, return the submitted values in the state and render them as
`defaultValue` (see below).

Define the state shape next to the action so the client and server share
one type:

```typescript
// app/actions/profile.ts
"use server";

export type ProfileFormState = {
  errors?: Record<string, string>;
  values?: { name: string };
} | null;

export async function saveProfile(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const name = (formData.get("name") as string)?.trim() ?? "";
  if (!name) {
    return { errors: { name: "Name is required" }, values: { name } };
  }
  await db.users.update({ name });
  return null; // success
}
```

```tsx
"use client";
import { useActionState } from "react";
import { saveProfile, type ProfileFormState } from "../actions/profile";

export function ProfileForm({ initial }: { initial: { name: string } }) {
  const [state, formAction, isPending] = useActionState<
    ProfileFormState,
    FormData
  >(saveProfile, null);

  return (
    <form action={formAction}>
      <input
        name="name"
        defaultValue={state?.values?.name ?? initial.name}
        aria-invalid={!!state?.errors?.name}
      />
      {state?.errors?.name && <p role="alert">{state.errors.name}</p>}
      <button type="submit" disabled={isPending}>
        {isPending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
```

**Why echo values into `defaultValue`** — React 19 resets a form's
uncontrolled fields after its `action` completes, and a no-JS submission
re-renders the whole page. In both cases the only thing that survives is what
you render, so return the submitted values in `state.values` and use them as
`defaultValue`. (A controlled `value` without an `onChange` would make the
inputs read-only.)

### 3. `useOptimistic` — instant UI before the action settles

For reactive UI like quantity controls, like buttons, or todo toggles.
Combine with `startTransition` so the optimistic update is part of the same
transition as the action call.

```tsx
"use client";
import { useOptimistic, startTransition } from "react";
import { updateQuantity } from "../actions/cart";

export function QuantityControl({
  productId,
  initialQuantity,
}: {
  productId: string;
  initialQuantity: number;
}) {
  const [optimistic, setOptimistic] = useOptimistic(
    initialQuantity,
    (_current, next: number) => next,
  );

  function change(delta: number) {
    const next = Math.max(0, optimistic + delta);
    startTransition(async () => {
      setOptimistic(next);
      await updateQuantity(productId, delta);
    });
  }

  return (
    <div>
      <button onClick={() => change(-1)}>-</button>
      <span>{optimistic}</span>
      <button onClick={() => change(1)}>+</button>
    </div>
  );
}
```

`useOptimistic` resets to the real value once the surrounding transition
settles and React re-renders with the post-action loader data.

### `useFormStatus` — pending state in nested children

When the submit button is in a separate component from the form, use
`useFormStatus()` instead of threading `isPending` down via props.

```tsx
"use client";
import { useFormStatus } from "react-dom";

export function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Working…" : children}
    </button>
  );
}
```

`useFormStatus` only reports the form it is rendered inside — it does not
observe other forms.

## Validation with Zod

Validate on the server, return structured errors via `useActionState`. Keep
the schema next to the action so client and server agree on the shape.

```typescript
// app/actions/signup.ts
"use server";

import { z } from "zod";
import { redirect } from "@rangojs/router";

const SignupSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "At least 8 characters"),
  name: z.string().min(1, "Required"),
});

export type SignupState = {
  errors?: Partial<Record<keyof z.infer<typeof SignupSchema>, string>>;
  values?: Partial<z.infer<typeof SignupSchema>>;
} | null;

export async function signup(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const raw = {
    email: formData.get("email") as string,
    password: formData.get("password") as string,
    name: formData.get("name") as string,
  };

  const parsed = SignupSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      errors[key] ??= issue.message; // first error per field
    }
    // Echo back values (omit password) so the form preserves user input.
    const { password: _drop, ...safeValues } = raw;
    return { errors, values: safeValues };
  }

  await db.users.create(parsed.data);
  throw redirect("/welcome");
}
```

The form reads `state.errors` field-by-field and re-uses `state.values` as
`defaultValue`s (see `useActionState` example above). Never echo back
secrets like passwords.

For schemas shared with a `useFetchLoader()` JSON body, parse the same way:

```typescript
const parsed = SignupSchema.safeParse(ctx.body);
```

## Revalidation After an Action

When an action mutates data, the matched route tree may need to partially
re-render so the UI updates. Rango runs the action, then evaluates
`revalidate()` on matched segments and loaders. Each path, layout, parallel,
intercept, or loader rule decides whether that piece re-renders/re-resolves.

Use `ctx.isAction()` for specific actions or modules. It accepts one action,
several actions, or a namespace import (`import * as CartActions`). Wrap it by
what the segment's default already does:

- **Add a signal** where the default skips (a parent layout or layout-level
  parallel): `ctx.isAction(CartActions) || undefined` re-renders it after cart
  actions and defers otherwise. On a loader or route segment it changes nothing.
- **Narrow after actions** where the default re-runs (loaders, the route, and
  segments inside the `path()`):
  `ctx.isAction() ? ctx.isAction(CartActions) : undefined` re-runs only for cart
  actions and keeps the navigation default.
- **Avoid bare `ctx.isAction(CartActions)`.** It is a hard `false` on navigation
  too, so a loader stops refetching when params change.

```typescript
// urls.tsx — inside the urls() callback. Nest each loader inside the path(),
// layout(), or parallel() that owns its data so the route tree mirrors the
// data dependencies.
import * as AccountActions from "./actions/account";
import * as CartActions from "./actions/cart";

urls(({ path, loader, revalidate }) => [
  path("/", HomePage, { name: "home" }, () => [
    // Loader data re-runs by default after any action. Opt out with revalidate(() => false).
    loader(StaticHomepageLoader, () => [revalidate(() => false)]),
  ]),

  // Re-render the cart page handler AND re-resolve its loader only after cart
  // actions (both re-run after every action by default)
  path("/cart", CartPage, { name: "cart" }, () => [
    revalidate((ctx) =>
      ctx.isAction() ? ctx.isAction(CartActions) : undefined,
    ),
    loader(CartLoader, () => [
      revalidate((ctx) =>
        ctx.isAction() ? ctx.isAction(CartActions) : undefined,
      ),
    ]),
  ]),

  // Re-run the loader only after actions exported by the account actions module
  path("/account", AccountPage, { name: "account" }, () => [
    loader(AccountLoader, () => [
      revalidate((ctx) =>
        ctx.isAction() ? ctx.isAction(AccountActions) : undefined,
      ),
    ]),
  ]),
]);
```

The raw `actionId` string stays available for broad path filters:

```typescript
// On a parent layout (skipped after actions by default): also re-render after
// any action under src/actions/account/, including modules not imported here.
revalidate(
  ({ actionId }) => actionId?.startsWith("src/actions/account/") || undefined,
);
```

For actions exported from a module-level `"use server"` file, the ID is prefixed
with the source file path (`src/actions/cart.ts#addToCart`). **Inline `"use
server"` actions** (declared inside an RSC component) intentionally keep their
hashed IDs — file paths are withheld from the client for security. If you need
file-path-based revalidation predicates, define the action in a module-level
`"use server"` file rather than inline. See `/loader` for the full revalidation
contract (deferred returns, soft suggestions).

### Cross-segment dependencies

If a loader reads `ctx.get()` data set by an outer layout/handler, that
outer segment must also re-run after the action — otherwise the loader sees
stale context. Share the same `revalidate` predicate on both producer and
consumer:

```typescript
import type { Revalidate } from "@rangojs/router";
import * as CartActions from "./actions/cart";

const revalidateCart: Revalidate = (ctx) =>
  ctx.isAction(CartActions) || undefined;

urls(({ path, layout, loader, revalidate }) => [
  layout(CartLayout, () => [
    revalidate(revalidateCart), // producer: re-renders after cart actions (skipped by default)
    path("/cart", CartPage, { name: "cart" }, () => [
      // consumer: loaders re-run after every action anyway; the shared
      // contract names the dependency
      loader(CartItemsLoader, () => [revalidate(revalidateCart)]),
    ]),
  ]),
]);
```

See `/middleware` for the full cross-segment revalidation contract.

## Client Cache After an Action

`revalidate()` decides what the server re-renders **in the action's response**.
Separately, the browser invalidates its own caches once the action's response
arrives: it marks the history cache stale (Back renders the cached entry, then
revalidates), flushes the prefetch cache, rotates the router's state cookie,
and tells other open tabs to do the same. This happens for every action that
reached the server, including ones that threw. No setup is needed.

### `keepClientCache()` — skip it for no-op actions

Some hot actions change nothing a route renders: a debounced draft autosave, an
analytics event, a save that turned out to be a no-op. Call `keepClientCache()`
inside the action to tell the client to leave its caches alone for this call:

```typescript
// app/actions/draft.ts
"use server";

import { keepClientCache } from "@rangojs/router";

export async function saveDraft(formData: FormData) {
  const changed = await drafts.persist(formData);
  if (!changed) keepClientCache(); // decided per call, not per action
  return { saved: true };
}
```

What it suppresses, for this action only: the stale-marking of the history
cache, the prefetch flush, the state-cookie rotation, the cross-tab broadcast,
and the background re-fetch the client runs when the user navigated away while
the action was in flight. What it does not change:

- The action's own response still carries the revalidation render your
  `revalidate()` rules select, and the client applies it.
- A concurrent action that did not call it still invalidates.
- An explicit `invalidateClientCache()` in the same action still rotates the
  cookie, so invalidation wins.

It is a server directive (an internal response header the client reads).
Outside a request it is a no-op with a dev warning; the client-side import is
also a no-op with a dev warning. Like `cookies()`, it throws inside a
`cache()` / `"use cache"` boundary. For the opposite case — a mutation the
router cannot see, such as a REST call or WebSocket push — use
`invalidateClientCache()` (see `/hooks`, `state.md`).

## Redirects

`redirect()` works inside actions. Both `return redirect(...)` and
`throw redirect(...)` are supported and behave the same way for the
client. Throwing is clearer when the redirect is conditional, and it keeps
the action's return type narrow (e.g. `Promise<void>`) — `redirect()` returns
a `Response`, so the `return` form needs `Promise<Response>` in the signature.
Prefer `throw redirect(...)`; never cast with `as any`.

```typescript
"use server";

import { redirect, cookies } from "@rangojs/router";
import { FlashMessage } from "../location-states";

export async function login(_prev: unknown, formData: FormData) {
  const email = formData.get("email") as string;
  const session = await authenticate(email);
  if (!session) return { error: "Invalid credentials" };

  cookies().set("session", session.token, { httpOnly: true, path: "/" });
  throw redirect("/dashboard", {
    state: FlashMessage({ text: "Welcome back!" }),
  });
}
```

Redirects from actions render the **target** route tree's matched segments
(paths, layouts, parallels, intercepts) and re-resolve its loaders, not the
source page's — the target is what the user sees next. See `/hooks
useLocationState` for reading flash state on the target page.

### Same-origin by default (open-redirect protection)

`redirect()` is same-origin by default on every path — JS, no-JS PE, and
full-page. A cross-origin target (e.g. from unvalidated user input) is blocked
and the user is sent to the app root instead, so `redirect(userInput)` can never
become an open redirect. To intentionally redirect off-host (an OAuth provider,
say), opt in explicitly:

```typescript
throw redirect("https://accounts.google.com/o/oauth2/v2/auth?...", {
  external: true,
});
```

`{ external: true }` is the audit point: passing user input with it re-opens the
cross-origin risk and is your responsibility (the Rails `allow_other_host: true`
model). Omit it and off-host targets stay blocked. `external` only waives the
**same-origin** rule, not scheme safety: the target must be `http(s)` — a
`javascript:` or `data:` URL is still neutralized, so a forged or mistaken
`external` target can never become a scriptable navigation.

## Error Handling

### Validation errors — return them as state

Recoverable errors (form validation, business rules) should be returned via
`useActionState`. The form re-renders with the error and the user can fix
it. Throwing for a validation error escalates to an error boundary, which
is usually too aggressive.

### Unexpected errors — let them throw

Throw for genuinely exceptional conditions (network failure, DB outage,
auth violation). The nearest `errorBoundary()` above the page the action was
called from catches them, and the boundary renders inside route middleware like
a normal render.

```typescript
// urls.tsx — inside the urls() callback
layout(CheckoutLayout, () => [
  // Server fallback: receives { error } only (ErrorInfo); there is no reset().
  errorBoundary(({ error }) => (
    <div role="alert">
      <p>
        {error.name === "ForbiddenError"
          ? "You cannot change this order."
          : "Checkout failed."}
      </p>
      <a href="/checkout">Try again</a>
    </div>
  )),
  path("/checkout", CheckoutPage, { name: "checkout" }),
]);
```

In production `error.message` is replaced with `"An error occurred"` (and
`stack` / `cause` are dropped), while `error.name` and `error.code` are kept —
branch on `name` or `code`, not on the message.

### Not found from an action

`notFound()` inside an action is handled like any other thrown error: it
renders the nearest `errorBoundary()` with `error.name === "DataNotFoundError"`.
`notFoundBoundary()` handles `notFound()` from handlers and loaders, not from
actions.

```typescript
// app/actions/posts.ts
"use server";

import { notFound } from "@rangojs/router";

export async function deletePost(id: string): Promise<void> {
  const post = await db.posts.find(id);
  if (!post) notFound("Post not found"); // → nearest errorBoundary()
  await db.posts.delete(id);
}
```

For a recoverable "already gone" case, return a result the form can show
(`{ error: "Post not found" }`) instead of throwing.

### Authorization in actions

Route middleware does **not** wrap action execution — only global
middleware (`router.use()`) does. Auth checks must therefore live in
`router.use()` or inside the action itself. Don't rely on a route-level
`middleware()` to gate action access.

An action is identified by its id, not by a URL: the client posts it to the
current page's URL, but any URL that matches a route can carry it. A
pattern-scoped `router.use("/admin/*", ...)` therefore guards action requests
posted from `/admin/*` pages, not the action itself. Use global middleware to
establish identity (load the session), and authorize sensitive actions inside
the action body.

```typescript
// router.tsx — global middleware wraps action + render
const router = createRouter()
  .use(authInit) // loads the session for every request, actions included
  .use("/admin/*", requireAdmin) // guards /admin pages and actions posted from them
  .routes(urlpatterns);
```

```typescript
// Or check inside the action body
"use server";
import { getRequestContext, redirect, notFound } from "@rangojs/router";

export class ForbiddenError extends Error {
  constructor() {
    super("You do not have permission to perform this action.");
    this.name = "ForbiddenError";
  }
}

export async function deleteOrder(orderId: string) {
  const ctx = getRequestContext();
  const user = ctx.get("user");
  if (!user) throw redirect("/login"); // unauthenticated → bounce to login

  const order = await db.orders.get(orderId);
  if (!order) notFound("Order not found"); // → errorBoundary (DataNotFoundError)
  if (order.userId !== user.id) throw new ForbiddenError(); // → errorBoundary

  await db.orders.delete(orderId);
}
```

> **Don't `throw new Response("Unauthorized", { status: 401 })`** — non-redirect
> Responses thrown from actions are treated as errors and routed to the nearest
> `errorBoundary()`, not returned as real HTTP responses (the dev build warns
> when you do this). Use `redirect()` to send unauthenticated users to a login
> page, and `notFound()` or a domain error class (branch on `error.name` in the
> boundary) for missing or forbidden resources. For recoverable cases, return
> `{ error: "..." }` via `useActionState` instead of throwing.

## Action Context

Actions can read the request context with `getRequestContext()`. This gives
the same context-variable, header, and reverse APIs that handlers and
middleware use.

```typescript
"use server";
import { getRequestContext, cookies, headers } from "@rangojs/router";

export async function trackEvent(name: string) {
  const ctx = getRequestContext();
  const user = ctx.get("user"); // set by global middleware
  const ua = headers().get("user-agent");
  const url = ctx.reverse("dashboard"); // type-safe URL by route name
  await analytics.record({ name, userId: user?.id, ua, url });
}
```

State written via `ctx.set(...)` or `cookies().set(...)` during an action
is visible to downstream route middleware, segment handlers (path/layout/
parallel/intercept), loaders, and `revalidate()` callbacks during the
post-action revalidation render — actions and revalidation share the same
request scope.

### Constraints

| Constraint                                               | Why                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Actions cannot return or throw a non-redirect `Response` | Return values go through RSC Flight serialization. A returned non-redirect `Response` is discarded and the page re-renders; a thrown one is treated as a regular error and hits the nearest `errorBoundary()` (dev warns in both cases). Use `redirect()`, `notFound()`, or domain errors. |
| Route DSL `middleware()` does not wrap actions           | Actions execute before route middleware. Only global `router.use()` middleware (and its scoped variants) wrap action execution.                                                                                                                                                            |
| Prefer actions over fetchable-loader POSTs for writes    | Only actions trigger the post-action revalidation render and the client-cache invalidation. A `useFetchLoader()` / `load({ method: "POST" })` call does neither (see `/loader` → "Mutation Context").                                                                                      |

Cookies/headers set in **global** `router.use()` middleware DO propagate to
action responses (the same merge path as a normal render). See `/middleware`
for the full middleware contract.

## File Uploads

Forms with `enctype="multipart/form-data"` (or any file input) submit to
actions as `FormData`. Stream the file directly — don't buffer if the
runtime supports streaming.

Write the action with the `(prevState, formData) => newState` signature so
it can be passed straight to `<form action={uploadAvatar}>` (PE-compatible)
**and** to `useActionState` without a client-side wrapper:

```typescript
// app/actions/avatar.ts
"use server";

import { getRequestContext } from "@rangojs/router";

export type AvatarUploadState = { url?: string; error?: string } | null;

export async function uploadAvatar(
  _prev: AvatarUploadState,
  formData: FormData,
): Promise<AvatarUploadState> {
  const file = formData.get("avatar") as File | null;
  if (!file || file.size === 0) return { error: "No file selected" };
  if (file.size > 5_000_000) return { error: "File too large (max 5MB)" };

  const ctx = getRequestContext();
  const key = `avatars/${crypto.randomUUID()}-${file.name}`;
  await ctx.env.BUCKET.put(key, file.stream());
  return { url: `/r2/${key}` };
}
```

```tsx
"use client";
import { useActionState } from "react";
import { uploadAvatar, type AvatarUploadState } from "../actions/avatar";

export function AvatarUpload() {
  const [state, action, pending] = useActionState<AvatarUploadState, FormData>(
    uploadAvatar,
    null,
  );
  return (
    <form action={action}>
      <input type="file" name="avatar" accept="image/*" />
      <button disabled={pending}>{pending ? "Uploading…" : "Upload"}</button>
      {state?.error && <p role="alert">{state.error}</p>}
      {state?.url && <img src={state.url} alt="" />}
    </form>
  );
}
```

Wrapping the action in a client-side inline function (`useActionState(async
(_prev, fd) => uploadAvatar(fd), null)`) breaks PE: that closure isn't a
server reference, so the form has no real `action` URL when JS hasn't
loaded. Keep the action's signature `(_prev, formData)` and pass it
directly.

For client-side upload progress or cancellation, use a fetchable loader
with `useFetchLoader()` instead — see `/hooks useFetchLoader`.

## Tracking Action State Without `useActionState`

Use `useAction()` from `@rangojs/router/client` to track an action's
state from outside a form (e.g. an action triggered by `onClick`).

```tsx
"use client";
import { useAction } from "@rangojs/router/client";
import { addToCart } from "../actions/cart";

function AddButton({ productId }: { productId: string }) {
  const { state, error } = useAction(addToCart);
  return (
    <>
      <button
        onClick={() => addToCart(productId)}
        disabled={state === "loading"}
      >
        {state === "loading" ? "Adding…" : "Add"}
      </button>
      {error instanceof Error && <p role="alert">{error.message}</p>}
    </>
  );
}
```

`error` is typed `unknown` (whatever the action threw), so narrow it before
reading `.message`.

`useActionState` and `useAction` are complementary — use `useActionState`
for `<form action={...}>` flows, `useAction` for imperative button clicks
or to observe an action triggered elsewhere on the page. See `/hooks`
(`handle-and-actions.md`) for the full `useAction` state shape and string
matching.

## Progressive Enhancement

`<form action={serverAction}>` works without JavaScript: the form posts as a
normal HTTP request, the action runs, and the page re-renders server-side.
For PE to work, the form's `action` must be the server reference itself, or a
`.bind(null, ...)` of it (React encodes bound arguments into the form, as in
pattern 1 above), or the dispatcher `useActionState` returns for it. A
client-side closure that calls the action is not a server reference and breaks
PE (see "File Uploads"). The simplest PE-safe shape:

```tsx
// Works with no-JS submission
<form action={submitName}>
  <input name="name" />
  <button>Submit</button>
</form>
```

```typescript
"use server";
export async function submitName(formData: FormData) {
  const name = formData.get("name") as string;
  await db.entries.add({ name });
}
```

`useActionState` and `useOptimistic` only enhance the experience once JS is
loaded — without JS, the underlying action still runs and the page still
re-renders (with the `useActionState` result restored as its state). Don't rely
on client-only state for required form behavior.

## Cross-references

- `/hooks` — `useAction`, `useFetchLoader`, `useLocationState` (flash state)
- `/loader` — read patterns, fetchable loaders, revalidation rule semantics
- `/middleware` — action vs render scope, revalidation contracts
- `/links` — `ctx.reverse()` and `getRequestContext().reverse()` from actions
- `/migrate-react-router` — `action()` → `"use server"` mapping
- `/migrate-nextjs` — Next.js server action parity
