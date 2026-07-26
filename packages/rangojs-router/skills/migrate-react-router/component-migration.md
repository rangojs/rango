# Middleware, Loading States, Navigation, Metadata, API Routes, and Theming

## 4. Middleware / Route Protection

React Router doesn't have built-in middleware. Protection is typically done in loaders:

```typescript
// React Router: auth check in loader
export async function loader({ request }) {
  const user = await getUser(request);
  if (!user) throw redirect("/login");
  return { user };
}

// Rango: router.use() for request-level auth
const router = createRouter({})
  .use(authInit) // all routes — resolves session
  .use("/dashboard/*", requireAuth) // scoped guard
  .routes(urlpatterns);
```

Use `router.use()` for auth guards (wraps entire request including actions).
Use DSL `middleware()` for render-level concerns (context shaping, headers).
See `/middleware`.

## 5. Loading & Error States

### Loading / Suspense

```typescript
// React Router: defer() + Suspense, or HydrateFallback
export async function loader() {
  return defer({ data: fetchData() });
}

// Rango: loading() DSL for automatic Suspense boundaries
path("/dashboard", DashboardPage, { name: "dashboard" }, () => [
  loading(<DashboardSkeleton />),
])
```

### Error boundaries

```typescript
// React Router:
{ path: "dashboard", element: <Dashboard />, errorElement: <ErrorPage /> }

// or with ErrorBoundary component:
function ErrorBoundary() {
  const error = useRouteError();
  return <div>Error: {error.message}</div>;
}

// Rango: errorBoundary() wrapping a group of routes
// Server-side error boundaries only receive `error` (no `reset` — server render
// cannot be retried; users can navigate away or refresh).
layout(<DashboardLayout />, () => [
  errorBoundary(({ error }) => (
    <div>
      <h2>Something went wrong</h2>
      <p>{error.message}</p>
    </div>
  )),
  path("/dashboard", DashboardIndex, { name: "dashboard" }),
  path("/dashboard/settings", Settings, { name: "settings" }),
])
```

### Not found

```typescript
// React Router: { path: "*", element: <NotFound /> }

// Rango (app-level):
createRouter({
  notFound: ({ pathname }) => <NotFoundPage pathname={pathname} />,
})

// Rango (route-level — catches notFound() thrown in handlers/loaders):
layout(<ShopLayout />, () => [
  notFoundBoundary(<ProductNotFound />),
  path("/product/:slug", ProductPage, { name: "product" }),
])
```

## 6. Navigation

| React Router                              | Rango                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `import { Link } from "react-router-dom"` | `import { Link } from "@rangojs/router/client"`                                  |
| `<Link to="/about">`                      | `<Link to="/about">`                                                             |
| `useNavigate()`                           | `useRouter()` from `@rangojs/router/client`                                      |
| `navigate("/about")`                      | `useRouter().push("/about")`                                                     |
| `navigate("/about", { replace: true })`   | `useRouter().replace("/about")`                                                  |
| `navigate(-1)`                            | `useRouter().back()`                                                             |
| `useLocation().pathname`                  | `usePathname()` from `@rangojs/router/client`                                    |
| `useSearchParams()`                       | `useSearchParams()` from `@rangojs/router/client`                                |
| `useParams()`                             | `useParams()` from `@rangojs/router/client` (or `ctx.params` in server handlers) |
| `useParams<T>()`                          | `useParams<T>()` — same generic annotation pattern                               |
| `<NavLink>`                               | `<Link>` with `usePathname()` for active state                                   |

### useNavigate → useRouter

```typescript
// React Router:
const navigate = useNavigate();
navigate("/dashboard");
navigate(-1);

// Rango:
const router = useRouter();
router.push("/dashboard");
router.back();
```

## 7. Metadata / Head

```typescript
// React Router: meta function export (framework mode)
export function meta() {
  return [{ title: "Home" }, { name: "description", content: "Welcome" }];
}

// Rango: Meta handle in server handlers
import { Meta } from "@rangojs/router";

const HomePage: Handler<"home"> = (ctx) => {
  const meta = ctx.use(Meta);
  meta({ title: "Home" });
  meta({ name: "description", content: "Welcome" });
  return <div>Home page</div>;
};
```

RR's data-derived `meta({ data })` maps to the same push from the LOADER that
owns the data — `ctx.use(Meta)({ title: data.name })` in the loader body, with
`loader(Def, { stream: "navigation" })` when the title must be in the SSR'd
head. See `/loader` → "Writing Handles from Loaders".

Add `<MetaTags />` in the Document component's `<head>`:

```typescript
import { MetaTags } from "@rangojs/router/client";

function Document({ children }: { children: ReactNode }) {
  return (
    <html>
      <head>
        <MetaTags />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

## 8. API / Resource Routes

```typescript
// React Router (framework mode):
// app/routes/api.users.ts
export async function loader() {
  return Response.json(await getUsers());
}

// Rango: response routes
path.json(
  "/api/users",
  async () => {
    return await getUsers();
  },
  { name: "apiUsers" },
);
```

See `/response-routes` for `path.json()`, `path.text()`, `path.html()`, etc.

## 9. Theme / Dark Mode

Rango has a built-in theme system with FOUC prevention. If the React Router app
uses a custom theme provider or `next-themes`, replace it with Rango's theme API:

```typescript
const router = createRouter({
  theme: true, // or { defaultTheme: "system", attribute: "class" }
});
```

Client components use `useTheme()` to read and toggle:

```typescript
"use client";
import { useTheme } from "@rangojs/router/theme";

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme}</button>;
}
```

See `/theme` for full API including system detection and cookie persistence.
