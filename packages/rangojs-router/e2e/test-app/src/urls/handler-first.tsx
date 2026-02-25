import { urls } from "@rangojs/router";
import { Link, Outlet, ParallelOutlet } from "@rangojs/router/client";
import type { Handler } from "@rangojs/router";

// Route handler sets data via ctx.set() — runs before layout and parallel children.
const HandlerFirstPage: Handler<"handlerFirst.index"> = (ctx) => {
  ctx.set("handlerData", "from-handler");
  return (
    <div data-testid="handler-first-page">
      <h1 data-testid="handler-first-title">Handler First</h1>
      <p data-testid="handler-set-value">Set: from-handler</p>
      <p data-testid="handler-first-timestamp">{Date.now()}</p>
      <Link to="/handler-first/cache-scope" data-testid="link-to-cached">
        Go to cached
      </Link>
    </div>
  );
};

// Orphan layout reads handler-set data via ctx.get() — proves handler ran first.
function HandlerFirstLayout(ctx: any) {
  const handlerData = ctx.get("handlerData");
  return (
    <div data-testid="handler-first-layout">
      <p data-testid="layout-get-value">
        Layout got: {handlerData ?? "undefined"}
      </p>
      <Outlet />
      <ParallelOutlet name="@hf-sidebar" />
    </div>
  );
}

// Parallel reads handler-set data via ctx.get() — proves handler ran first.
function HandlerFirstSidebar(ctx: any) {
  const handlerData = ctx.get("handlerData");
  return (
    <aside data-testid="handler-first-sidebar">
      <p data-testid="sidebar-get-value">
        Sidebar got: {handlerData ?? "undefined"}
      </p>
    </aside>
  );
}

// Cache scope test: handler sets timestamp via ctx.set(), parallel reads it.
// On cache hit both return the same cached value — proves all segments cached together.
function CacheScopeHandler(ctx: any) {
  const ts = Date.now();
  ctx.set("cacheTs", String(ts));
  return (
    <div data-testid="cache-scope-page">
      <h1 data-testid="cache-scope-title">Cache Scope Test</h1>
      <p data-testid="cache-scope-handler-ts">{ts}</p>
      <ParallelOutlet name="@cs-sidebar" />
      <Link to="/handler-first" data-testid="link-to-uncached">
        Go to uncached
      </Link>
    </div>
  );
}

function CacheScopeSidebar(ctx: any) {
  const ts = ctx.get("cacheTs");
  return (
    <aside data-testid="cache-scope-sidebar">
      <p data-testid="cache-scope-sidebar-ts">{ts ?? "undefined"}</p>
    </aside>
  );
}

export const handlerFirstPatterns = urls(
  ({ path, layout, parallel, cache, revalidate }) => [
    // Handler-first test: handler sets data, orphan layout + parallel read it.
    // revalidate(() => true) forces fresh content on every client navigation.
    path("/", HandlerFirstPage, { name: "index" }, () => [
      layout(HandlerFirstLayout, () => [
        parallel({ "@hf-sidebar": HandlerFirstSidebar }),
      ]),
      revalidate(() => true),
    ]),

    // Cache scope test: all children cached together (cached route for mix test)
    cache({ ttl: 600 }, () => [
      path("/cache-scope", CacheScopeHandler, { name: "cacheScope" }, () => [
        parallel({ "@cs-sidebar": CacheScopeSidebar }),
      ]),
    ]),
  ],
);
