# A large app with a protected admin area

The shape for a signed-in product: a dashboard or SaaS app with public
marketing pages, sign-in, an onboarding flow, the app itself, settings, an
admin area for staff, and a JSON API.

- **A server (RSC) shell** renders the chrome of every signed-in page: the
  top nav and the user menu. It renders on the document load and is kept on
  every navigation inside the areas below it.
- **User and app data come from loaders**, read with `useLoader()` where they
  are shown. Request-scoped values (the session user) come from middleware
  `ctx.set()`.
- **Each large area is its own `clientUrls()` group**: `auth`, `onboarding`,
  `app`, `settings`, `admin`, each mounted under the shell with a sync
  `include()`.
- **Middleware gates each area**: the session is resolved globally, a
  sign-in guard wraps every protected include (`auth` sits outside it), an
  onboarding gate wraps the app and settings, and a role guard wraps admin.
- **Links prefetch**, and `prefetch: false` keeps the expensive loaders out
  of the prefetches that rarely become clicks.

## How navigations behave in this shape

- **Inside a group** (`/app` to `/app/projects/42`): the group's definition
  matches in the browser, so the destination renders at the click, its loader
  reads suspend behind their own `<Suspense>`, and the group layout's
  `useOutlet().pending` turns on. Loaders whose `revalidate()` says hold keep
  their data. The canonical request still goes to the server.
- **Between groups** (`/app/projects` to `/settings`): a normal server
  navigation. Only the mounted group matches locally
  (`src/client-urls/navigation.ts`), so there is no optimistic frame; the
  shell is kept (its segment and its loader are not re-rendered) and the
  destination group's layout mounts.
- **Every navigation sends a request, and route middleware wraps each one.**
  A user whose session ended is redirected on the next click, inside a group
  or not; the instant feel comes from held data and the optimistic frame, not
  from skipping the server.

Where the loaders, `<Suspense>` boundaries and `revalidate()` rules go so
that these navigations show the next page early and never flash a fallback
is the `ux-architecture` skill's subject; this file places the routes, the
middleware and the data around them.

## File tree

```
src/
  router.tsx                  createRouter(), global middleware
  router.named-routes.gen.ts  generated (Vite plugin / rango generate), committed
  document.tsx                "use client" Document
  urls.tsx                    root: marketing, auth, the shell and its groups, api
  middleware/
    session.ts                loadSession (global): CurrentUser from the cookie
    guards.ts                 requireUser, requireOnboarded, requireAdmin, requireUserForFetch
    maintenance.ts            optional: throw rewrite("maintenance"), a global router.use()
    same-origin.ts            requireSameOrigin for /api (see /response-routes, CSRF)
  shell/
    app-shell.tsx             server layout: nav, user menu slot, <Outlet />
    user-menu.tsx             "use client": useLoader(ViewerLoader)
    boundaries.tsx            AppError, AppNotFound
  loaders/                    viewer.ts, projects.ts, …
  actions/                    "use server": auth.ts, profile.ts, projects.ts, admin.ts, …
  urls/
    marketing.tsx             urls(): public pages, ppr
    auth.client.tsx           clientUrls(): login, signup
    onboarding.client.tsx     clientUrls(): the onboarding steps
    app.client.tsx            clientUrls(): dashboard, projects
    app.predicates.ts         revalidate() predicates the app group shares
    settings.client.tsx       clientUrls(): profile, billing
    admin.client.tsx          clientUrls(): users
    api.tsx                   urls(): path.json() routes
    *.gen.ts                  generated per module by rango generate, committed
  pages/                      server pages (marketing, maintenance)
```

## router.tsx

```tsx
// src/router.tsx
import { createRouter } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
import { Document } from "./document";
import { urlpatterns } from "./urls";
import { loadSession } from "./middleware/session";
import { maintenance } from "./middleware/maintenance";
import { requireSameOrigin } from "./middleware/same-origin";

export const router = createRouter({
  document: Document,
  // The store behind ppr shells, cache() and "use cache". One process here;
  // CFCacheStore on Workers, VercelCacheStore on Vercel.
  cache: { store: new MemorySegmentCacheStore() },
})
  .use(maintenance) // optional, runs first
  .use(loadSession) // every request: renders, actions, fetchable loaders
  .use("/api/*", requireSameOrigin)
  .routes(urlpatterns);
```

`defaultPrefetch` is left at its default: `"none"` in development,
`"viewport"` in production, so every visible `<Link>` prefetches its route.
On pages with long lists of links, pass `prefetch="hover"` on those links, or
set the router default to `"hover"` or `"adaptive"` (`/links`).

## The middleware

```ts
// src/middleware/session.ts
import { cookies, createVar } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";
import { sessions, type User } from "../lib/db";

// cache: false: a cache() boundary or "use cache" function that reads it
// throws instead of storing one user's data for everyone.
export const CurrentUser = createVar<User>({ cache: false });

// Global: resolves identity on every request. It does not gate.
export const loadSession: Middleware = async (ctx, next) => {
  const token = cookies().get("session")?.value;
  const user = token ? await sessions.verify(token) : null;
  if (user) ctx.set(CurrentUser, user);
  return next();
};
```

```ts
// src/middleware/guards.ts
import { redirect } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";
import { CurrentUser } from "./session";

// Route middleware: wraps every render of the routes below it, document loads
// and client navigations. It does not wrap server actions or fetchable-loader
// calls.
export const requireUser: Middleware = async (ctx, next) => {
  if (!ctx.get(CurrentUser)) {
    return redirect(ctx.reverse("auth.login", {}, { next: ctx.pathname }));
  }
  return next();
};

export const requireOnboarded: Middleware = async (ctx, next) => {
  if (!ctx.get(CurrentUser)?.onboarded) {
    return redirect(ctx.reverse("onboarding.start"));
  }
  return next();
};

export const requireAdmin: Middleware = async (ctx, next) => {
  if (ctx.get(CurrentUser)?.role !== "admin") {
    return redirect(ctx.reverse("app.dashboard"));
  }
  return next();
};

// Per-loader middleware for fetchable loaders. A redirect on that lane would
// hand the login page's HTML to load(); answer 401 instead.
export const requireUserForFetch: Middleware = async (ctx, next) => {
  if (!ctx.get(CurrentUser)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return next();
};
```

`ctx.reverse()` in middleware takes global names only and fills no params
from the request, so the guards name full routes (`auth.login`) and pass the
search object the login route's schema declares. (`getRequestContext().reverse`
in route middleware does fill mount params after the match.)

```ts
// src/middleware/maintenance.ts (optional)
import { rewrite } from "@rangojs/router";
import type { Middleware } from "@rangojs/router";
import { flags } from "../lib/flags";

export const maintenance: Middleware = async (ctx, next) => {
  if (!flags.maintenance || ctx.pathname === "/maintenance") return next();
  // A rewrite moves a server action or form post to its target, where the
  // action runs: a lock answers mutations itself (HEAD rewrites like GET).
  if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") {
    return new Response("Maintenance", { status: 503 });
  }
  throw rewrite("maintenance"); // renders /maintenance at the visitor's URL
};
```

## urls.tsx

```tsx
// src/urls.tsx
import { urls } from "@rangojs/router";
import { marketingPatterns } from "./urls/marketing";
import authUrls from "./urls/auth.client";
import onboardingUrls from "./urls/onboarding.client";
import appUrls from "./urls/app.client";
import settingsUrls from "./urls/settings.client";
import adminUrls from "./urls/admin.client";
import { apiPatterns } from "./urls/api";
import { AppShell } from "./shell/app-shell";
import { AppError, AppNotFound } from "./shell/boundaries";
import { ViewerLoader } from "./loaders/viewer";
import { MaintenancePage } from "./pages/marketing";
import { updateProfile } from "./actions/profile";
import {
  requireAdmin,
  requireOnboarded,
  requireUser,
} from "./middleware/guards";

export const urlpatterns = urls(
  ({
    path,
    layout,
    include,
    middleware,
    loader,
    revalidate,
    errorBoundary,
    notFoundBoundary,
  }) => [
    // Public server routes with ppr shells.
    include("/", marketingPatterns, { name: "marketing" }),

    // Outside the guard: requireUser redirects here.
    include("/auth", authUrls, { name: "auth" }),

    // Every signed-in page shares one server shell.
    layout(AppShell, () => [
      middleware(requireUser),
      loader(ViewerLoader, () => [
        // A loader above the route re-runs after every action by default;
        // only a profile change touches this one. Navigations hold it.
        revalidate((ctx) =>
          ctx.isAction() ? ctx.isAction(updateProfile) : undefined,
        ),
      ]),
      errorBoundary(AppError),
      notFoundBoundary(AppNotFound),

      include("/onboarding", onboardingUrls, { name: "onboarding" }),
      middleware(requireOnboarded, () => [
        include("/app", appUrls, { name: "app" }),
        include("/settings", settingsUrls, { name: "settings" }),
      ]),
      middleware(requireAdmin, () => [
        include("/admin", adminUrls, { name: "admin" }),
      ]),
    ]),

    include("/api", apiPatterns, { name: "api" }),
    path("/maintenance", MaintenancePage, { name: "maintenance" }),
  ],
);
```

- `middleware(guard, () => [include(...)])` scopes the guard to the routes
  of those includes: it is a transparent layout that carries the middleware.
- Route middleware runs outer to inner: a signed-out request for `/settings`
  meets `requireUser` (redirect to `/auth/login?next=%2Fsettings`) before
  `requireOnboarded`.
- `onboarding` sits inside `requireUser` but outside `requireOnboarded`, or
  the gate would redirect to itself. A middleware around the `auth` include
  can send signed-in users on to `/app` the same way.

## The shell

```tsx
// src/shell/app-shell.tsx: a server layout
import { Suspense } from "react";
import type { HandlerContext } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { UserMenu } from "./user-menu";

export function AppShell(ctx: HandlerContext) {
  return (
    <div className="app">
      <header>
        <nav>
          <Link to={ctx.reverse("app.dashboard")}>Dashboard</Link>
          <Link to={ctx.reverse("app.projects")}>Projects</Link>
          <Link to={ctx.reverse("settings.profile")}>Settings</Link>
        </nav>
        <Suspense fallback={<span className="avatar-skeleton" />}>
          <UserMenu adminHref={ctx.reverse("admin.users")} />
        </Suspense>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
```

```tsx
// src/shell/user-menu.tsx
"use client";

import { Link, useLoader } from "@rangojs/router/client";
import { ViewerLoader } from "../loaders/viewer";
import { logout } from "../actions/auth";

export function UserMenu({ adminHref }: { adminHref: string }) {
  const { data: viewer } = useLoader(ViewerLoader);
  return (
    <div className="user-menu">
      <span>{viewer.name}</span>
      {viewer.role === "admin" ? <Link to={adminHref}>Admin</Link> : null}
      <form action={logout}>
        <button type="submit">Sign out</button>
      </form>
    </div>
  );
}
```

```ts
// src/loaders/viewer.ts
import { createLoader } from "@rangojs/router";
import { CurrentUser } from "../middleware/session";
import { requireUserForFetch } from "../middleware/guards";

// An options object makes the loader fetchable (refetch() works on it); the
// middleware guards that fetch lane.
export const ViewerLoader = createLoader(
  async (ctx) => {
    const user = ctx.get(CurrentUser)!;
    return { name: user.name, email: user.email, role: user.role };
  },
  { middleware: [requireUserForFetch] },
);
```

The shell renders no user data itself: the user menu reads the loader under
its own `<Suspense>`, so the nav paints before the loader answers. Any
component below the shell can read `useLoader(ViewerLoader)` too (the
settings form below does); the read walks up to the layout that registered
it (`src/use-loader.tsx`).

## The groups

Each group is a `"use client"` module whose default export is a
`clientUrls()` definition: named function components, loaders from
`createLoader()`, no handlers.

```tsx
// src/urls/auth.client.tsx
"use client";

import { useActionState } from "react";
import { clientUrls, useOutlet, useSearchParams } from "@rangojs/router/client";
import { login } from "../actions/auth";

function AuthLayout() {
  const { content } = useOutlet();
  return <div className="auth-card">{content}</div>;
}

function LoginPage() {
  const [state, formAction, pending] = useActionState(login, null);
  const [search] = useSearchParams();
  return (
    <form action={formAction}>
      <input type="hidden" name="next" value={search.get("next") ?? ""} />
      <input name="email" type="email" />
      <input name="password" type="password" />
      {state?.error ? <p role="alert">{state.error}</p> : null}
      <button disabled={pending}>Sign in</button>
    </form>
  );
}

function SignupPage() {
  return <form>{/* … */}</form>;
}

export default clientUrls(({ path, layout }) => [
  layout(AuthLayout, () => [
    path("/login", LoginPage, { name: "login", search: { next: "string?" } }),
    path("/signup", SignupPage, { name: "signup" }),
  ]),
]);
```

```tsx
// src/urls/app.client.tsx
"use client";

import { Suspense, useActionState } from "react";
import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useReverse,
} from "@rangojs/router/client";
import {
  ActivityLoader,
  ProjectLoader,
  ProjectsLoader,
  StatsLoader,
} from "../loaders/projects";
import { renameProject } from "../actions/projects";
import { projectData } from "./app.predicates";
import { routes } from "./app.client.gen";

function AppLayout() {
  const { content, pending } = useOutlet();
  const reverse = useReverse(routes); // mount-aware: "/app/projects"
  return (
    <div aria-busy={pending}>
      <nav>
        <Link to={reverse("dashboard")}>Overview</Link>
        <Link to={reverse("projects")}>Projects</Link>
      </nav>
      {content}
    </div>
  );
}

function Stats() {
  const { data } = useLoader(StatsLoader);
  return <p>{data.projects} projects</p>;
}
function Dashboard() {
  return (
    <Suspense fallback={<p>…</p>}>
      <Stats />
    </Suspense>
  );
}

function ProjectRows() {
  const { data: projects } = useLoader(ProjectsLoader);
  const reverse = useReverse(routes);
  return (
    <ul>
      {projects.map((p) => (
        <li key={p.id}>
          <Link to={reverse("project", { projectId: p.id })}>{p.name}</Link>
        </li>
      ))}
    </ul>
  );
}
function ProjectList() {
  return (
    <Suspense fallback={<p>Loading projects…</p>}>
      <ProjectRows />
    </Suspense>
  );
}

function ProjectHeader() {
  const { data: project } = useLoader(ProjectLoader);
  const [, formAction, pending] = useActionState(renameProject, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="projectId" value={project.id} />
      <input name="name" defaultValue={project.name} />
      <button disabled={pending}>Rename</button>
    </form>
  );
}

function Activity() {
  const { data: items } = useLoader(ActivityLoader);
  return (
    <ul>
      {items.map((i) => (
        <li key={i.id}>{i.text}</li>
      ))}
    </ul>
  );
}

function ProjectPage() {
  return (
    <>
      <Suspense fallback={<h1>…</h1>}>
        <ProjectHeader />
      </Suspense>
      <Suspense fallback={<p>Loading activity…</p>}>
        <Activity />
      </Suspense>
    </>
  );
}

export default clientUrls(({ path, layout, loader, revalidate }) => [
  layout(AppLayout, () => [
    path("/", Dashboard, { name: "dashboard" }, () => [loader(StatsLoader)]),
    path(
      "/projects",
      ProjectList,
      { name: "projects", search: { q: "string?" } },
      () => [loader(ProjectsLoader)],
    ),
    path("/projects/:projectId", ProjectPage, { name: "project" }, () => [
      loader(ProjectLoader, () => [revalidate(projectData)]),
      // Below the fold and costly: kept out of link prefetches.
      loader(ActivityLoader, { prefetch: false }, () => [
        revalidate(projectData),
      ]),
    ]),
  ]),
]);
```

```ts
// src/urls/app.predicates.ts: no "use client"
import type { RevalidateParams } from "@rangojs/router";
import { renameProject } from "../actions/projects";

// After an action: re-run only for a rename of THIS project.
// On a navigation: re-run when the project changes.
export function projectData(ctx: RevalidateParams): boolean | undefined {
  if (ctx.isAction()) {
    return (
      ctx.isAction(renameProject) &&
      ctx.actionResult?.projectId === ctx.currentParams.projectId
    );
  }
  return ctx.currentParams.projectId !== ctx.nextParams.projectId
    ? ctx.defaultShouldRevalidate
    : false;
}
```

A group's `revalidate()` runs on the server; the build hoists it out of the
`"use client"` module, so its argument may reference imports and globals only.
A predicate that several loaders share lives in its own module without
`"use client"` (`/client-urls` → "Revalidation runs on the server").

`onboarding.client.tsx`, `settings.client.tsx` and `admin.client.tsx` follow
the same pattern:

```tsx
// src/urls/settings.client.tsx (excerpt)
function ProfileForm() {
  const { data: viewer } = useLoader(ViewerLoader); // registered on the shell
  const [state, formAction, pending] = useActionState(updateProfile, null);
  return (
    <form action={formAction}>
      <input name="name" defaultValue={viewer.name} />
      {state && !state.ok ? <p role="alert">{state.error}</p> : null}
      <button disabled={pending}>Save</button>
    </form>
  );
}

export default clientUrls(({ path, layout }) => [
  layout(SettingsLayout, () => [
    path("/", ProfilePage, { name: "profile" }), // ProfileForm under <Suspense>
    path("/billing", BillingPage, { name: "billing" }),
  ]),
]);
```

```tsx
// src/urls/admin.client.tsx (excerpt)
export default clientUrls(({ path, layout, loader, revalidate }) => [
  layout(AdminLayout, () => [
    path("/", UsersPage, { name: "users", search: { q: "string?" } }, () => [
      loader(UsersLoader, () => [
        revalidate(({ isAction }) =>
          isAction() ? isAction(setRole) : undefined,
        ),
      ]),
    ]),
  ]),
]);
```

## Marketing and the API

```tsx
// src/urls/marketing.tsx
import { urls } from "@rangojs/router";
import { HomePage, MarketingLayout, PricingPage } from "../pages/marketing";

// Public and the same for every visitor: each page serves from a ppr shell.
export const marketingPatterns = urls(({ path, layout }) => [
  layout(MarketingLayout, () => [
    path("/", HomePage, { name: "home", ppr: true }),
    path("/pricing", PricingPage, { name: "pricing", ppr: true }),
  ]),
]);
```

A marketing header that shows the signed-in state reads it from a live
loader under `<Suspense>`, never in a handler: a `cookies()` read the shell
capture waits for refuses the capture, and the page stays a MISS (`/ppr`).

```ts
// src/urls/api.tsx
import { urls } from "@rangojs/router";
import { db } from "../lib/db";
import { CurrentUser } from "../middleware/session";

export const apiPatterns = urls(({ path }) => [
  path.json("/health", () => ({ ok: true }), { name: "health" }),
  path.json(
    "/projects",
    async (ctx) => {
      const user = ctx.get(CurrentUser); // set by the global loadSession
      if (!user)
        throw Response.json({ error: "unauthorized" }, { status: 401 });
      return db.projects.list(user.id);
    },
    { name: "projects" },
  ),
]);
```

Response routes skip the RSC pipeline and the router's `originCheck`. A
cookie-authenticated route that changes state needs the same-origin guard
(`requireSameOrigin` in `/response-routes` → "CSRF"), mounted here with
`router.use("/api/*", …)`.

## Loaders, caches and actions

```ts
// src/loaders/projects.ts
import { cacheTag, createLoader, notFound } from "@rangojs/router";
import { db } from "../lib/db";
import { CurrentUser } from "../middleware/session";
import { requireUserForFetch } from "../middleware/guards";

// Shared by everyone who opens the project: cached and tagged.
async function getProject(id: string) {
  "use cache";
  cacheTag(`project:${id}`);
  return db.projects.get(id);
}

export const ProjectLoader = createLoader(
  async (ctx) => {
    const project = await getProject(ctx.params.projectId!);
    if (!project) notFound("No such project"); // AppNotFound renders
    return project;
  },
  { middleware: [requireUserForFetch] }, // fetchable, guarded
);

// Per user: a live loader, never cached.
export const ProjectsLoader = createLoader(async (ctx) =>
  db.projects.list(
    ctx.get(CurrentUser)!.id,
    ctx.searchParams.get("q") ?? undefined,
  ),
);

// Costly: registered with { prefetch: false } in the app group.
export const ActivityLoader = createLoader(async (ctx) =>
  db.activity.list(ctx.params.projectId!),
);

export const StatsLoader = createLoader(async (ctx) =>
  db.stats.forUser(ctx.get(CurrentUser)!.id),
);
```

```ts
// src/actions/projects.ts
"use server";

import { getRequestContext, redirect, updateTag } from "@rangojs/router";
import { db } from "../lib/db";
import { CurrentUser } from "../middleware/session";

export async function renameProject(_prev: unknown, formData: FormData) {
  // Route middleware does not wrap actions: check here.
  const ctx = getRequestContext();
  if (!ctx.get(CurrentUser)) throw redirect(ctx.reverse("auth.login"));
  const projectId = String(formData.get("projectId"));
  await db.projects.rename(projectId, String(formData.get("name")));
  await updateTag(`project:${projectId}`); // every user's cached copy
  return { ok: true as const, projectId };
}
```

The `admin` actions check the role the same way: `requireAdmin` guards the
admin pages, not the actions they call, and any URL that matches a route can
carry an action (`/server-actions` → "Authorization in actions").

## Prefetch and `prefetch: false`

A `<Link>` prefetch is the navigation sent early: the server runs the
destination's loaders, and a click that adopts it commits the complete page.
`loader(Def, { prefetch: false })` keeps one loader out of every prefetch; a
click then shows the page with that loader's fallback and sends one
follow-up request (the fill) for it.

The flag moves that loader's wait to after the click. In one measurement on a real app (development build, a
loaded machine, a hover then a click 150 ms later), a `clientUrls()` tab
whose loader was flagged showed its content 843 to 918 ms after the click,
and the same tab prefetched whole showed it in 77 to 157 ms. The gap is the
flagged loader's own latency, the fill's round trip, and React holding a
revealed fallback for at least 300 ms.

Rules of thumb:

- Flag a loader that is expensive or metered, and whose prefetches mostly
  never become clicks: activity feeds, analytics panels, reviews below the
  fold, a list behind a tab.
- Do not flag what the likely click needs first: the page's main content.
- Read a flagged loader inside its own `<Suspense>`; with no boundary, React
  keeps the page being left on screen until the fill answers.
- A same-route click (`/app/projects/1` to `/app/projects/2`) prefetches a
  flagged loader as usual: only data the page does not have yet is deferred.

Details: `/loader` → "`prefetch: false`", `/client-urls` → "`prefetch: false`".

## Keeping data current

| Change                                                                     | Mechanism                                                                                                                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| This user's own mutation                                                   | A server action plus `revalidate()` rules on the loaders it touches (`isAction(ref)`, `actionResult`): the server re-runs exactly those, in the action's response |
| The same data cached for many users                                        | `"use cache"` with `cacheTag()`, dropped by `updateTag()` in the action (awaited: the action's own response reads fresh)                                          |
| A change this tab did not make (a push, polling, another tab, a REST call) | `refetch()` / `load()` from `useLoader()`, `useRefreshLoaders()(group)` for several loaders, plus `invalidateClientCache()` for prefetches and history            |
| "Re-render everything on this page"                                        | `useRouter().refresh()`: refetches the current page with no held segments, so every segment and loader renders                                                    |
| An action that changed nothing visible (an autosave)                       | `keepClientCache()` in the action: the browser keeps its prefetches and history cache                                                                             |

```tsx
// src/shell/live-updates.tsx
"use client";

import { useEffect } from "react";
import { invalidateClientCache } from "@rangojs/router";
import { useLoader } from "@rangojs/router/client";
import { ProjectLoader } from "../loaders/projects";

// Another user renamed the project: their action already dropped the server
// cache (updateTag). This tab refetches what it shows and drops its
// prefetches and history cache.
export function ProjectLiveUpdates({ projectId }: { projectId: string }) {
  const { refetch } = useLoader(ProjectLoader);
  useEffect(() => {
    // An SSE route (path.stream, see the streams-and-websockets skill).
    const events = new EventSource(`/api/projects/${projectId}/events`);
    events.onmessage = () => {
      invalidateClientCache();
      void refetch();
    };
    return () => events.close();
  }, [projectId, refetch]);
  return null;
}
```

`load()`, `refetch` and `useRefreshLoaders()` call the loader through the
`_rsc_loader` endpoint, which serves only fetchable loaders:
`createLoader(fn, true)`, or `createLoader(fn, { middleware })`. A plain
`createLoader(fn)` answers 403 there. That request runs `router.use()`
middleware and the loader's own `middleware` list, and **no route
middleware** (`src/rsc/handler.ts`, `src/rsc/loader-fetch.ts`): the
`requireUser` around the include does not protect a refetch. The session
comes from the global `loadSession`, and each fetchable loader in a
protected group lists its guard (`requireUserForFetch` above). For several
loaders at once, tag the reads with `useLoader(Def, { refreshGroup: "account" })`
and call `useRefreshLoaders()("account")` (plain GET, no params).

## Names, links and generated files

The include names make the route names: `auth.login`, `app.dashboard`,
`app.project`, `settings.profile`, `admin.users`, `api.projects`,
`marketing.home`.

- Server code links with `ctx.reverse("app.project", { projectId })` (handlers,
  layouts, loaders; middleware with global names only).
- A group's components link inside the group with `useReverse(routes)` and
  the group's generated map (`./app.client.gen`): mount-aware, params filled
  from the URL.
- A server action redirects by name too: `getRequestContext().reverse("auth.login")`
  (global names; see `renameProject`). Client components that need a URL from
  another module take it as a prop from the server layout, as `UserMenu` does.
- Static paths with no route behind them: `href("/healthz")`.

Generated and committed: `src/router.named-routes.gen.ts`, and from
`rango generate src` one `*.gen.ts` per module (`urls/app.client.gen.ts`,
`urls/auth.client.gen.ts`, …, `urls/api.gen.ts`). Wire `rango generate src`
into a `predev` script so a new route never waits for a manual run.

### URL-scoped tenants

If the account or project is in the URL, nest the includes and let every
module link by local name; none of them reads `:accountId` itself.

```tsx
// router.tsx urls: include("/:accountId", accountUrls, { name: "account" })
// urls/account.tsx: include("/:projectId", projectUrls, { name: "project" })

// urls/project.tsx, on /acme/web/issues
ctx.reverse(".issue", { issueId: "7" }); // /acme/web/issues/7
ctx.reverse("account.settings"); // /acme/settings, cross-module: global name
// urls/project.client.tsx
const reverse = useReverse(routes); // ./project.client.gen
reverse(".issues", { projectId: "api" }); // /acme/api/issues
```

- A link into another module (the project nav's "Account settings") is built
  on the server and passed as a prop or loader data. `useReverse(accountRoutes)`
  in a project component gives a wrong URL with no error (dc-t57).
- A server layout stays held when `:projectId` changes (partial rendering by
  design), so links it rendered keep the old project. Render the project
  switcher and nav in a client component with `useReverse(routes)`, or give
  the layout a `revalidate()` comparing `projectId`.
- The account layout's `ctx.reverse(".settings")` resolves in the account
  module on every page below it, the project's pages included: it links to
  `/acme/settings`, not the project's settings route.

Links built on the server, from the RSC as a prop or from a loader as data,
carry every param already filled; the client component only renders them:

```tsx
// urls/project.tsx (server): build the links where the names resolve
export const ProjectNavLoader = createLoader((ctx) => ({
  issues: ctx.reverse(".issues"), // /acme/web/issues
  settings: ctx.reverse(".settings"), // /acme/web/settings
  account: ctx.reverse("account.settings"), // /acme/settings, another module
}));

export const projectUrls = urls(({ layout, path, loader, revalidate }) => [
  layout(
    // From the RSC: fine for links that do not follow :projectId.
    (ctx) => <ProjectShell accountHref={ctx.reverse("account.settings")} />,
    () => [
      // From a loader: held like the layout, re-run when the project changes.
      loader(ProjectNavLoader, () => [
        revalidate(({ currentParams, nextParams }) =>
          currentParams.projectId !== nextParams.projectId ? true : undefined,
        ),
      ]),
      path("/issues", Issues, { name: "issues" }),
      path("/settings", Settings, { name: "settings" }),
    ],
  ),
]);
```

```tsx
"use client";
export function ProjectNav() {
  const { data: links } = useLoader(ProjectNavLoader);
  return (
    <nav>
      <Link to={links.issues}>Issues</Link>
      <Link to={links.settings}>Settings</Link>
      <Link to={links.account}>Account</Link>
    </nav>
  );
}
```

## Why each piece sits where it does

| Piece                                      | Where                                                          | Why                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session lookup                             | `router.use(loadSession)`                                      | The only layer that wraps actions and fetchable-loader calls too; one lookup, read everywhere with `ctx.get(CurrentUser)`                             |
| Sign-in, onboarding, role gates            | `middleware()` around the includes                             | Runs on every document load and navigation into those routes, so every click is re-authorized; the group itself cannot hold middleware                |
| Authorization of a mutation                | inside the action, and the fetchable loader's `middleware`     | Route middleware does not wrap either                                                                                                                 |
| Top nav, user menu                         | the server `AppShell` layout                                   | Spans every group; rendered once, kept across navigations within and between groups                                                                   |
| The user's data                            | `loader(ViewerLoader)` on the shell, `useLoader()` in the menu | Live per request; held on navigations; re-run only after the actions its `revalidate()` names                                                         |
| Area chrome (tabs, pending state)          | the group's `layout()`                                         | Matches in the browser: instant at the click, `useOutlet().pending`, instance kept across the group's routes                                          |
| Error and not-found UI for signed-in pages | `errorBoundary()` / `notFoundBoundary()` on the shell          | Groups reject DSL boundaries; one on the server layout around the mounts catches a group loader's throw or `notFound()`, and the shell's chrome stays |
| Marketing pages                            | server `urls()` with `ppr`                                     | Same HTML for every visitor; the first byte comes from the stored shell                                                                               |
| JSON API                                   | `path.json()` in `urls/api.tsx`                                | Outside the RSC pipeline; guard state-changing routes against CSRF                                                                                    |
| A cached read shared by users              | `"use cache"` + `cacheTag()` inside the loader                 | Loaders stay live; the expensive call is what caches, and `updateTag()` reaches every user                                                            |

## Mistakes this shape avoids

- **Trusting the include's guard for actions and refetches.** It wraps renders
  only. Authorize in the action body and in each fetchable loader's
  `middleware`.
- **Putting `auth` (or `onboarding`) inside the gate that redirects to it**:
  a redirect loop.
- **Reading the session in a `ppr` handler** (a marketing header with the
  user's name): the capture is refused and the page never serves a shell.
- **`prefetch: false` on every loader**: each click then waits for a fill.
  Flag the expensive, rarely-clicked ones.
- **A bare `isAction(refs)` predicate**: it is a hard `false` on navigation
  too, so the loader stops following param changes. Use
  `isAction() ? isAction(refs) : undefined` (`/loader`).
