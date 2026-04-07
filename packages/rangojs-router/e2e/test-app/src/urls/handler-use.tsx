import {
  urls,
  createLoader,
  createVar,
  middleware,
  loader,
  loading,
  revalidate,
  parallel,
} from "@rangojs/router";
import { Outlet, ParallelOutlet, Link } from "@rangojs/router/client";
import type { Handler } from "@rangojs/router";

// ---------------------------------------------------------------------------
// Loaders & context vars
// ---------------------------------------------------------------------------

export const HandlerUseLoader = createLoader(async () => ({
  message: "from-handler-use-loader",
  timestamp: Date.now(),
}));

export const SidebarLoader = createLoader(async () => ({
  section: "sidebar-data",
}));

export const PanelLoader = createLoader(async () => ({
  section: "panel-data",
}));

// Slow loader — triggers loading state during client-side navigation
export const SlowSidebarLoader = createLoader(async () => {
  await new Promise((r) => setTimeout(r, 300));
  return { section: "slow-sidebar-data" };
});

const LayoutMwVar = createVar<string>();

// ---------------------------------------------------------------------------
// Handlers with .use
// ---------------------------------------------------------------------------

// A handler that carries its own loader + middleware via .use
const HandlerUsePage: Handler<"/handler-use"> = async (ctx) => {
  const data = await ctx.use(HandlerUseLoader);
  return (
    <div data-testid="handler-use-page">
      <h1 data-testid="handler-use-title">Handler Use Test</h1>
      <p data-testid="handler-use-data">{data.message}</p>
      <p data-testid="handler-use-ts">{data.timestamp}</p>
      <Link to="/handler-use/parallel-override" data-testid="link-to-override">
        Go to override test
      </Link>
    </div>
  );
};
HandlerUsePage.use = () => [
  loader(HandlerUseLoader),
  middleware(async (ctx, next) => {
    await next();
    ctx.header("X-Handler-Use-Default", "applied");
  }),
];

// A handler with .use that also receives explicit use items at the mount site
const MergedPage: Handler<"/handler-use/merged"> = async (ctx) => {
  const data = await ctx.use(HandlerUseLoader);
  return (
    <div data-testid="merged-page">
      <h1 data-testid="merged-title">Merged Use Test</h1>
      <p data-testid="merged-data">{data.message}</p>
    </div>
  );
};
MergedPage.use = () => [
  loader(HandlerUseLoader),
  middleware(async (ctx, next) => {
    await next();
    ctx.header("X-Handler-Use-Default", "applied");
  }),
];

// A layout handler with .use
const HandlerUseLayout: Handler = (ctx) => {
  const mwValue = ctx.get(LayoutMwVar);
  return (
    <div data-testid="handler-use-layout">
      <p data-testid="layout-mw-value">Layout MW: {mwValue ?? "none"}</p>
      <Outlet />
    </div>
  );
};
HandlerUseLayout.use = () => [
  middleware(async (ctx, next) => {
    ctx.set(LayoutMwVar, "from-layout-use");
    await next();
    ctx.header("X-Handler-Use-Layout", "applied");
  }),
];

// -- Parallel slot handlers with per-slot handler.use -------------------------

// Page that hosts two parallel slots
const ParallelPage: Handler<"/handler-use/parallel"> = () => (
  <div data-testid="parallel-page">
    <h1 data-testid="parallel-title">Parallel Slot Use Test</h1>
    <ParallelOutlet name="@sidebar" />
    <ParallelOutlet name="@panel" />
  </div>
);

// Each slot carries its own loader via handler.use — no cross-slot bleed
const SidebarSlot: Handler = async (ctx) => {
  const data = await ctx.use(SidebarLoader);
  return (
    <aside data-testid="parallel-sidebar">
      <p data-testid="sidebar-section">{data.section}</p>
    </aside>
  );
};
SidebarSlot.use = () => [loader(SidebarLoader)];

const PanelSlot: Handler = async (ctx) => {
  const data = await ctx.use(PanelLoader);
  return (
    <section data-testid="parallel-panel">
      <p data-testid="panel-section">{data.section}</p>
    </section>
  );
};
PanelSlot.use = () => [loader(PanelLoader)];

// -- Parallel slot handler.use + explicit loading() override ------------------

// This component must never render. If handler.use loading overwrites
// the explicit loading (wrong merge order), React will throw during
// client-side navigation and the e2e test will catch it via expectNoPageError.
function ThrowingLoading(): React.JSX.Element {
  throw new Error("handler.use loading() rendered — explicit override failed");
}

const ParallelOverridePage: Handler<"/handler-use/parallel-override"> = () => (
  <div data-testid="parallel-override-page">
    <h1 data-testid="parallel-override-title">Parallel Override Use Test</h1>
    <ParallelOutlet name="@sidebar" />
    <Link to="/handler-use" data-testid="link-back">
      Back
    </Link>
  </div>
);

const OverrideSidebar: Handler = async (ctx) => {
  const data = await ctx.use(SlowSidebarLoader);
  return (
    <aside data-testid="override-sidebar">
      <p data-testid="override-sidebar-section">{data.section}</p>
    </aside>
  );
};
// handler.use provides loader + a loading that THROWS.
// The explicit use() below provides the real loading — it must win.
OverrideSidebar.use = () => [
  loader(SlowSidebarLoader),
  loading(<ThrowingLoading />),
];

// -- handler.use provides parallel slot, explicit use overrides it ------------

// This handler must never execute. If handler.use's parallel(@sidebar) survives
// past the explicit override, this handler runs and the page errors out.
const ThrowingSidebar: Handler = () => {
  throw new Error(
    "handler.use parallel @sidebar ran — explicit override failed",
  );
};

const ParallelSlotOverridePage: Handler<
  "/handler-use/parallel-slot-override"
> = () => (
  <div data-testid="slot-override-page">
    <h1 data-testid="slot-override-title">Parallel Slot Override Test</h1>
    <ParallelOutlet name="@sidebar" />
  </div>
);

// handler.use attaches a throwing @sidebar default
ParallelSlotOverridePage.use = () => [
  parallel({ "@sidebar": ThrowingSidebar }),
];

// The real sidebar — explicit use() replaces the throwing default
const RealSidebar: Handler = () => (
  <aside data-testid="real-sidebar">
    <p data-testid="real-sidebar-text">real-sidebar-content</p>
  </aside>
);

// ---------------------------------------------------------------------------
// Route patterns
// ---------------------------------------------------------------------------

export const handlerUsePatterns = urls(({ path, layout, parallel }) => [
  layout(HandlerUseLayout, () => [
    // handler.use alone (loader + middleware)
    path("/", HandlerUsePage, { name: "index" }),

    // handler.use + explicit use (adds additional middleware)
    path("/merged", MergedPage, { name: "merged" }, () => [
      middleware(async (ctx, next) => {
        await next();
        ctx.header("X-Explicit-Use", "applied");
      }),
    ]),

    // Two parallel slots, each with own handler.use loader — no bleed
    path("/parallel", ParallelPage, { name: "parallel" }, () => [
      parallel({ "@sidebar": SidebarSlot, "@panel": PanelSlot }),
    ]),

    // Parallel slot handler.use + explicit use override.
    // handler.use provides loading(<ThrowingLoading />) — must NOT render.
    // Explicit use provides the real loading — must win by order.
    path(
      "/parallel-override",
      ParallelOverridePage,
      { name: "parallelOverride" },
      () => [
        parallel({ "@sidebar": OverrideSidebar }, () => [
          loading(<div data-testid="override-loading">Loading sidebar...</div>),
        ]),
      ],
    ),

    // handler.use provides parallel(@sidebar: ThrowingSidebar) default.
    // Explicit use replaces @sidebar with RealSidebar.
    // If the default survives, the page throws.
    path(
      "/parallel-slot-override",
      ParallelSlotOverridePage,
      { name: "parallelSlotOverride" },
      () => [parallel({ "@sidebar": RealSidebar })],
    ),
  ]),
]);
