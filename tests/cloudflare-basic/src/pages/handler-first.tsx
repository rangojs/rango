import { urls } from "@rangojs/router";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

// Route handler sets data via ctx.set() -- runs before layout and parallel children.
function HandlerFirstPage(ctx: any) {
  ctx.set("handlerData", "from-handler");
  return (
    <div data-testid="handler-first-page">
      <h1 data-testid="handler-first-title">Handler First</h1>
      <p data-testid="handler-set-value">Set: from-handler</p>
      <p data-testid="handler-first-timestamp">{Date.now()}</p>
    </div>
  );
}

// Orphan layout reads handler-set data via ctx.get() -- proves handler ran first.
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

// Parallel reads handler-set data via ctx.get() -- proves handler ran first.
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

export const handlerFirstPatterns = urls(({ path, layout, parallel }) => [
  path("/", HandlerFirstPage, { name: "index" }, () => [
    layout(HandlerFirstLayout, () => [
      parallel({ "@hf-sidebar": HandlerFirstSidebar }),
    ]),
  ]),
]);
