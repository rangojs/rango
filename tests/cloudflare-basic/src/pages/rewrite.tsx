import {
  cookies,
  createLoader,
  createVar,
  getRequestContext,
  rewrite,
  urls,
  type HandlerContext,
  type Middleware,
} from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { RwClientLocation, RwItemLoads } from "./rewrite.client.js";
import { rwFailItem, rwSaveCart, rwSaveItem } from "./rewrite.actions.js";
import {
  bumpRwItemLoads,
  bumpRwItemRenders,
  getRwItemSaves,
} from "./rewrite-saves.js";

// throw rewrite() fixtures (e2e/rewrite.test.ts). The `rw-lock` cookie turns
// the lock on per test: "on" is the maintenance recipe (pages rewrite to
// /rw/maintenance, mutations get a 503 Response), "strict" rewrites every
// method with disallowMutations(), so a server action under it is refused
// before it runs.

const RwLock = createVar<{ reason: string }>();
/** Global middleware runs on /rw/*: one per pass of the request. */
const RwRuns = createVar<number>();
/** The same middleware's count, skipped on a rewritten pass. */
const RwCount = createVar<number>();
/** Runs of the maintenance route's own middleware. */
const RwTargetRuns = createVar<number>();
/** The visitor's path, set before a rewrite to the ppr item (#1146). */
const RwPublic = createVar<string>();
/** Set by the item route's own middleware: the target's chain ran. */
const RwItemGuard = createVar<string>();

/** Counts runs and adds a post-next() header (mounted on /rw/* in router.tsx). */
export const rwCountMiddleware: Middleware = async (ctx, next) => {
  ctx.set(RwRuns, (ctx.get(RwRuns) ?? 0) + 1);
  if (!ctx.rewrittenFrom) ctx.set(RwCount, (ctx.get(RwCount) ?? 0) + 1);
  await next();
  // Only the pass that produced the response resumes after next().
  ctx.header("x-rw-post", ctx.pathname);
};

/** The lock, loops and an inline path guard (mounted on /rw/* in router.tsx). */
export const rwLockMiddleware: Middleware = async (ctx, next) => {
  const mode = cookies().get("rw-lock")?.value;
  if (ctx.pathname === "/rw/loop-a") throw rewrite("/rw/loop-b");
  if (ctx.pathname === "/rw/loop-b") throw rewrite("/rw/loop-a");
  if (ctx.pathname === "/rw/gone") throw rewrite("/rw/nowhere");
  if (ctx.pathname === "/rw/self") throw rewrite("/rw/self");
  // A rewrite to a ppr route (#1146): /rw/promo/:id chooses no shell (it
  // renders live at the visitor's URL), /rw/summer/:id keys a shell of its
  // own by the visitor's URL, /rw/shared/:id shares the target's shell.
  const ppr = /^\/rw\/(promo|summer|shared)\/([\w-]+)$/.exec(ctx.pathname);
  if (ppr) {
    ctx.set(RwPublic, ctx.pathname);
    const target = rewrite("rw.pprItem", { id: ppr[2]! });
    if (ppr[1] === "summer") throw target.shell("visitor");
    if (ppr[1] === "shared") throw target.shell("target");
    throw target;
  }
  // A global rewrite into a pattern-guarded path.
  if (ctx.pathname === "/rw/global-to-guarded") throw rewrite("rw.guarded");
  // A routing rewrite of every method from a URL no route matches (a
  // multi-tenant host, an A/B split): the item page's forms post here, and
  // their actions run on the item's pass (#1145). rw-lock=strict opts out.
  const global = /^\/rw\/global\/(\d+)$/.exec(ctx.pathname);
  if (global) {
    const target = rewrite("rw.item", { id: global[1]! });
    throw mode === "strict" ? target.disallowMutations() : target;
  }
  // A rewrite after next() ran the route: an error.
  if (ctx.pathname === "/rw/after") {
    await next();
    throw rewrite("rw.shop");
  }
  // An inline path guard decides on the URL being rendered.
  if (
    ctx.pathname === "/rw/inline-admin" &&
    cookies().get("rw-admin")?.value !== "1"
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  const locked =
    ctx.pathname === "/rw/shop" || ctx.pathname.startsWith("/rw/products/");
  if (!mode || !locked) return next();
  if (mode === "on" && ctx.request.method !== "GET") {
    return new Response("Maintenance", {
      status: 503,
      headers: { "Retry-After": "600" },
    });
  }
  ctx.set(RwLock, { reason: "deploy" });
  cookies().set("rw-pass-one", "kept", { path: "/" });
  const maintenance = rewrite("rw.maintenance");
  throw mode === "strict" ? maintenance.disallowMutations() : maintenance;
};

/**
 * The lock on a clientUrls() group's detail pages (rw-lock=client-urls, mounted
 * on /__client-urls/:slug in router.tsx; the group's index stays reachable
 * because a trailing `*` would also match the bare mount): the navigation shows
 * the next page optimistically, then the response applies the rewritten route.
 */
export const rwClientUrlsLockMiddleware: Middleware = async (_ctx, next) => {
  if (cookies().get("rw-lock")?.value !== "client-urls") return next();
  throw rewrite("rw.maintenance");
};

/** Pattern-scoped guard for /rw/guarded/* (mounted in router.tsx). */
export const rwGuardMiddleware: Middleware = async (_ctx, next) => {
  if (cookies().get("rw-auth")?.value !== "1") {
    return new Response("Unauthorized", { status: 401 });
  }
  return next();
};

function RwLayout() {
  return (
    <div data-testid="rw-layout">
      <nav>
        <Link to="/rw" data-testid="rw-link-index">
          Index
        </Link>{" "}
        <Link to="/rw/shop" data-testid="rw-link-shop">
          Shop
        </Link>{" "}
        <Link to="/rw/products/hat" data-testid="rw-link-product">
          Hat
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

function RwIndex() {
  return <h1 data-testid="rw-index">Rewrite index</h1>;
}

function RwShop() {
  return (
    <section data-testid="rw-shop">
      <h1>Shop</h1>
      <form action={rwSaveCart}>
        <button type="submit" data-testid="rw-save">
          Save cart
        </button>
      </form>
    </section>
  );
}

function RwProduct(ctx: HandlerContext<{ slug: string }>) {
  return <h1 data-testid="rw-product">{`Product ${ctx.params.slug}`}</h1>;
}

function RwMaintenance(ctx: HandlerContext) {
  const from = ctx.rewrittenFrom;
  return (
    <section data-testid="rw-maintenance">
      <h1>Down for maintenance</h1>
      <span data-testid="rw-reason">{ctx.get(RwLock)?.reason ?? "none"}</span>
      <span data-testid="rw-pathname">{ctx.pathname}</span>
      <span data-testid="rw-from">
        {from ? `${from.pathname}${from.search}` : "none"}
      </span>
      <span data-testid="rw-runs">{String(ctx.get(RwRuns) ?? 0)}</span>
      <span data-testid="rw-count">{String(ctx.get(RwCount) ?? 0)}</span>
      <span data-testid="rw-target-runs">
        {String(ctx.get(RwTargetRuns) ?? 0)}
      </span>
      <RwClientLocation />
    </section>
  );
}

function rwKey(): string {
  return cookies().get("rw-key")?.value ?? "none";
}

/** The item page's loader: counts its runs for the test's key. */
export const RwItemLoader = createLoader(async () => ({
  loads: bumpRwItemLoads(rwKey()),
}));

/**
 * The target of /rw/public/:id and /rw/global/:id. Its save button posts to
 * the visitor's URL, whose middleware rewrites every method (#1145).
 */
function RwItem(ctx: HandlerContext<{ id: string }>) {
  return (
    <section data-testid="rw-item">
      <h1>{`Item ${ctx.params.id}`}</h1>
      <span data-testid="rw-item-guard">{ctx.get(RwItemGuard) ?? "none"}</span>
      <span data-testid="rw-item-saves">{String(getRwItemSaves(rwKey()))}</span>
      <span data-testid="rw-item-renders">
        {String(bumpRwItemRenders(rwKey()))}
      </span>
      <RwItemLoads loader={RwItemLoader} />
      <span data-testid="rw-runs">{String(ctx.get(RwRuns) ?? 0)}</span>
      <form action={rwSaveItem}>
        <button type="submit" data-testid="rw-item-save">
          Save item
        </button>
      </form>
      <form action={rwFailItem}>
        <button type="submit" data-testid="rw-item-fail">
          Fail save
        </button>
      </form>
      <RwClientLocation />
    </section>
  );
}

/** The item's error boundary: it reads what the item's route middleware set. */
function RwItemBoundary() {
  return (
    <section data-testid="rw-item-boundary">
      <span data-testid="rw-item-boundary-guard">
        {getRequestContext().get(RwItemGuard) ?? "none"}
      </span>
    </section>
  );
}

/** A ppr page that renders the location (usePathname) and the visitor's path. */
function RwPprItem(ctx: HandlerContext<{ id: string }>) {
  const from = ctx.rewrittenFrom;
  return (
    <section data-testid="rw-ppr-item">
      <h1>{`Item ${ctx.params.id}`}</h1>
      <span data-testid="rw-ppr-public">{ctx.get(RwPublic) ?? "none"}</span>
      <span data-testid="rw-ppr-from">{from ? from.pathname : "none"}</span>
      <RwClientLocation />
    </section>
  );
}

export const rewritePatterns = urls(
  ({ path, layout, middleware, errorBoundary, loader, revalidate }) => [
    layout(RwLayout, () => [
      path("/", RwIndex, { name: "index" }),
      path("/shop", RwShop, { name: "shop" }, () => [
        middleware(async (ctx, next) => {
          await next();
          ctx.header("x-rw-shop-post", "ran");
        }),
      ]),
      path("/products/:slug", RwProduct, { name: "product" }),
      path("/items/:id", RwItem, { name: "item" }, () => [
        middleware(async (ctx, next) => {
          ctx.set(RwItemGuard, "target");
          await next();
        }),
        errorBoundary(() => <RwItemBoundary />),
        // Re-run only for another item: a sort change, or an action, holds it.
        loader(RwItemLoader, () => [
          revalidate(
            ({ currentParams, nextParams }) =>
              currentParams.id !== nextParams.id,
          ),
        ]),
      ]),
      // A catch-all-style routing rewrite whose own params are not the
      // target's (#1144): navigating from the page it shows diffs against the
      // item route, not this one.
      path(
        "/catalog/:slug",
        () => <h1>never rendered</h1>,
        {},
        () => [
          middleware((ctx) => {
            throw rewrite(`/rw/items/${ctx.params.slug}${ctx.url.search}`);
          }),
        ],
      ),
      // A routing rewrite in route middleware, for every method: a server
      // action or a no-JS form post from the item page re-renders the item.
      path(
        "/public/:id",
        () => <h1>never rendered</h1>,
        {},
        () => [
          middleware((ctx) => {
            throw rewrite(`/rw/items/${ctx.params.id}`);
          }),
          errorBoundary(() => <p data-testid="rw-public-boundary">visitor</p>),
        ],
      ),
      // The same rewrite for GETs only: route middleware sees the render
      // after an action as the page's GET, so it rewrites that render too.
      path(
        "/get-only/:id",
        () => <h1>never rendered</h1>,
        {},
        () => [
          middleware((ctx, next) => {
            if (ctx.request.method !== "GET") return next();
            throw rewrite(`/rw/items/${ctx.params.id}`);
          }),
        ],
      ),
      path("/maintenance", RwMaintenance, { name: "maintenance" }, () => [
        // The target sets its own status.
        middleware(async (ctx, next) => {
          ctx.set(RwTargetRuns, (ctx.get(RwTargetRuns) ?? 0) + 1);
          getRequestContext().setStatus(503);
          ctx.header("Retry-After", "600");
          await next();
        }),
      ]),
      path(
        "/guarded/page",
        () => <h1 data-testid="rw-guarded">Guarded page</h1>,
        { name: "guarded" },
      ),
      path(
        "/to-guarded",
        () => <h1>never rendered</h1>,
        {},
        () => [
          middleware(() => {
            throw rewrite("rw.guarded");
          }),
        ],
      ),
      path(
        "/inline-admin",
        () => <h1 data-testid="rw-inline-admin">Inline admin</h1>,
        { name: "inlineAdmin" },
      ),
      path(
        "/to-inline-admin",
        () => <h1>never rendered</h1>,
        {},
        () => [
          middleware(() => {
            throw rewrite("/rw/inline-admin");
          }),
        ],
      ),
      // A route middleware chain that rewrites from its inner middleware: the
      // outer one's code after next() never runs.
      path(
        "/route-to-maintenance",
        () => <h1>never rendered</h1>,
        {},
        () => [
          middleware(async (ctx, next) => {
            await next();
            ctx.header("x-rw-route-post", "visitor");
          }),
          middleware(() => {
            throw rewrite("rw.maintenance");
          }),
        ],
      ),
      path("/global-to-guarded", () => <h1>never rendered</h1>),
      path("/after", () => <h1 data-testid="rw-after">after page</h1>),
      path("/self", () => <h1>self</h1>),
      path("/ppr/:id", RwPprItem, { name: "pprItem", ppr: true }),
      path("/promo/:id", () => <h1>never rendered</h1>),
      path("/summer/:id", () => <h1>never rendered</h1>),
      path("/shared/:id", () => <h1>never rendered</h1>),
      path("/handler-throws", () => {
        throw rewrite("/rw/shop");
      }),
      path("/loop-a", () => <h1>loop a</h1>),
      path("/loop-b", () => <h1>loop b</h1>),
      path("/gone", () => <h1>gone</h1>),
    ]),
  ],
);
