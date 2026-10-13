import {
  cookies,
  createVar,
  getRequestContext,
  rewrite,
  urls,
  type HandlerContext,
  type Middleware,
} from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import { RwClientLocation } from "./rewrite.client.js";
import { rwSaveCart, rwSaveItem } from "./rewrite.actions.js";
import { getRwItemSaves } from "./rewrite-saves.js";

// throw rewrite() fixtures (e2e/rewrite.test.ts). The `rw-lock` cookie turns
// the lock on per test: "on" is the maintenance recipe (pages rewrite to
// /rw/maintenance, mutations get a 503 Response), "naive" rewrites every
// method, so a server action under it is the rewrite-on-mutation error.

const RwLock = createVar<{ reason: string }>();
/** Global middleware runs on /rw/*: one per pass of the request. */
const RwRuns = createVar<number>();
/** The same middleware's count, skipped on a rewritten pass. */
const RwCount = createVar<number>();
/** Runs of the maintenance route's own middleware. */
const RwTargetRuns = createVar<number>();
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
  if (ctx.pathname === "/rw/loop-a") throw rewrite("/rw/loop-b");
  if (ctx.pathname === "/rw/loop-b") throw rewrite("/rw/loop-a");
  if (ctx.pathname === "/rw/gone") throw rewrite("/rw/nowhere");
  if (ctx.pathname === "/rw/self") throw rewrite("/rw/self");
  // A global rewrite into a pattern-guarded path.
  if (ctx.pathname === "/rw/global-to-guarded") throw rewrite("rw.guarded");
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

  const mode = cookies().get("rw-lock")?.value;
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
  throw rewrite("rw.maintenance");
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

/**
 * The target of /rw/public/:id. Its save button posts to the visitor's URL,
 * whose route middleware rewrites every method (#1145).
 */
function RwItem(ctx: HandlerContext<{ id: string }>) {
  return (
    <section data-testid="rw-item">
      <h1>{`Item ${ctx.params.id}`}</h1>
      <span data-testid="rw-item-guard">{ctx.get(RwItemGuard) ?? "none"}</span>
      <span data-testid="rw-item-saves">
        {String(getRwItemSaves(cookies().get("rw-key")?.value ?? "none"))}
      </span>
      <span data-testid="rw-runs">{String(ctx.get(RwRuns) ?? 0)}</span>
      <form action={rwSaveItem}>
        <button type="submit" data-testid="rw-item-save">
          Save item
        </button>
      </form>
      <RwClientLocation />
    </section>
  );
}

export const rewritePatterns = urls(({ path, layout, middleware }) => [
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
    ]),
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
    path("/handler-throws", () => {
      throw rewrite("/rw/shop");
    }),
    path("/loop-a", () => <h1>loop a</h1>),
    path("/loop-b", () => <h1>loop b</h1>),
    path("/gone", () => <h1>gone</h1>),
  ]),
]);
