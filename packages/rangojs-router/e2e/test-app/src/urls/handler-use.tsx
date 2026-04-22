import {
  urls,
  createLoader,
  createVar,
  middleware,
  loader,
  loading,
  revalidate,
  parallel,
  intercept,
  layout,
  when,
  cookies,
} from "@rangojs/router";
import { Outlet, ParallelOutlet, Link } from "@rangojs/router/client";
import type { Handler } from "@rangojs/router";
import { handlerUseLoaderAction } from "../actions.js";

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
      <Link
        to="/handler-use/slot-descriptor"
        data-testid="link-to-slot-descriptor"
      >
        Go to slot descriptor test
      </Link>
      <Link to="/handler-use/slot-opt-out" data-testid="link-to-slot-opt-out">
        Go to slot opt-out test
      </Link>
      <Link to="/handler-use/three-layer" data-testid="link-to-three-layer">
        Go to three-layer merge test
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

// -- Slot descriptor `{ handler, use }` for per-slot loading() ---------------

// Two slow slots so we can observe the loading state per slot.
export const SlowPanelLoader = createLoader(async () => {
  await new Promise((r) => setTimeout(r, 300));
  return { section: "slow-panel-data" };
});

const SlotDescriptorPage: Handler<"/handler-use/slot-descriptor"> = () => (
  <div data-testid="slot-descriptor-page">
    <h1 data-testid="slot-descriptor-title">Slot Descriptor Test</h1>
    <ParallelOutlet name="@sidebar" />
    <ParallelOutlet name="@panel" />
    <Link to="/handler-use" data-testid="link-back-descriptor">
      Back
    </Link>
  </div>
);

const DescriptorSidebar: Handler = async (ctx) => {
  const data = await ctx.use(SlowSidebarLoader);
  return (
    <aside data-testid="descriptor-sidebar">
      <p data-testid="descriptor-sidebar-section">{data.section}</p>
    </aside>
  );
};
DescriptorSidebar.use = () => [loader(SlowSidebarLoader)];

const DescriptorPanel: Handler = async (ctx) => {
  const data = await ctx.use(SlowPanelLoader);
  return (
    <section data-testid="descriptor-panel">
      <p data-testid="descriptor-panel-section">{data.section}</p>
    </section>
  );
};
DescriptorPanel.use = () => [loader(SlowPanelLoader)];

// -- Slot-local loading(false) opts one slot out while sibling streams -------

const SlotOptOutPage: Handler<"/handler-use/slot-opt-out"> = () => (
  <div data-testid="slot-opt-out-page">
    <h1 data-testid="slot-opt-out-title">Slot Opt-Out Test</h1>
    <ParallelOutlet name="@sidebar" />
    <ParallelOutlet name="@panel" />
    <Link to="/handler-use" data-testid="link-back-opt-out">
      Back
    </Link>
  </div>
);

// -- Three-layer merge regression (handler.use + shared + slot-local) --------

// Distinct loaders, one per layer, so we can observe each layer's effect in
// the rendered output. If any layer silently stops flowing through, one of
// the three markers disappears from the DOM.
export const ThreeLayerHandlerLoader = createLoader(async () => ({
  mark: "three-layer-handler",
}));
export const ThreeLayerSharedLoader = createLoader(async () => ({
  mark: "three-layer-shared",
}));
export const ThreeLayerSlotLocalLoader = createLoader(async () => ({
  mark: "three-layer-slot-local",
}));

const ThreeLayerSidebar: Handler = async (ctx) => {
  const h = await ctx.use(ThreeLayerHandlerLoader);
  const s = await ctx.use(ThreeLayerSharedLoader);
  const l = await ctx.use(ThreeLayerSlotLocalLoader);
  return (
    <aside data-testid="three-layer-sidebar">
      <span data-testid="three-layer-handler-mark">{h.mark}</span>
      <span data-testid="three-layer-shared-mark">{s.mark}</span>
      <span data-testid="three-layer-slot-local-mark">{l.mark}</span>
    </aside>
  );
};
// handler.use layer — this loader must flow through to ctx.use on the slot
ThreeLayerSidebar.use = () => [loader(ThreeLayerHandlerLoader)];

const ThreeLayerPage: Handler<"/handler-use/three-layer"> = () => (
  <div data-testid="three-layer-page">
    <h1 data-testid="three-layer-title">Three-Layer Merge Test</h1>
    <ParallelOutlet name="@sidebar" />
    <Link to="/handler-use" data-testid="link-back-three-layer">
      Back
    </Link>
  </div>
);

// -- Loader handler.use: revalidate rule attaches and is invoked on action

// Module-scoped spy — the router calls our revalidate rule when the page
// revalidates after an action, but only if handler.use on the loader
// definition is honored at mount time. `ctx.use` bypasses the skip decision,
// so we observe attachment via invocation count rather than loader-rerun.
let revalidateCallCount = 0;

export const StableLoader = createLoader(async () => ({
  ts: `${Date.now()}-${Math.random()}`,
}));
StableLoader.use = () => [
  revalidate(() => {
    revalidateCallCount += 1;
    return false;
  }),
];

const LoaderHandlerUsePage: Handler<"/handler-use/loader-use"> = async (
  ctx,
) => {
  await ctx.use(StableLoader);
  const actionCookie =
    cookies().get("handler-use-loader-action")?.value ?? "none";
  return (
    <div data-testid="loader-use-page">
      <h1 data-testid="loader-use-title">Loader Handler Use Test</h1>
      <p data-testid="loader-use-reval-count">{revalidateCallCount}</p>
      <p data-testid="loader-use-action-cookie">{actionCookie}</p>
      <form action={handlerUseLoaderAction}>
        <button type="submit" data-testid="loader-use-action-btn">
          Trigger action
        </button>
      </form>
    </div>
  );
};

// -- Intercept handler.use: middleware attached via .use fires on intercept --

const InterceptMwVar = createVar<string>();

const InterceptModalLayout: Handler = () => (
  <div data-testid="intercept-modal-layout">
    <Outlet />
    <ParallelOutlet name="@modal" />
  </div>
);

const InterceptSourcePage: Handler<"/handler-use/intercept-source"> = () => (
  <div data-testid="intercept-source-page">
    <h2 data-testid="intercept-source-title">Intercept Source</h2>
    <Link
      to="/handler-use/intercept-target"
      data-testid="link-intercept-target"
    >
      Open Target
    </Link>
  </div>
);

const InterceptTargetPage: Handler<"/handler-use/intercept-target"> = () => (
  <div data-testid="intercept-target-page">
    <h2 data-testid="intercept-target-title">Intercept Target (full)</h2>
  </div>
);

// Intercept handler with .use — middleware sets a context var the handler reads.
// If intercept() honors handler.use, the rendered value reflects the mw write.
const InterceptedModal: Handler = (ctx) => {
  const value = ctx.get(InterceptMwVar);
  return (
    <div data-testid="intercepted-modal">
      <span data-testid="intercepted-modal-value">{value ?? "NO-VALUE"}</span>
    </div>
  );
};
InterceptedModal.use = () => [
  middleware(async (ctx, next) => {
    ctx.set(InterceptMwVar, "intercept-mw-ran");
    await next();
  }),
];

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

    // Per-slot loading() via slot descriptor. @sidebar declares its own
    // loading skeleton; @panel does not. Without slot-local use, putting
    // loading() in the shared callback would broadcast it to both slots.
    path(
      "/slot-descriptor",
      SlotDescriptorPage,
      { name: "slotDescriptor" },
      () => [
        parallel({
          "@sidebar": {
            handler: DescriptorSidebar,
            use: () => [
              loading(
                <div data-testid="descriptor-sidebar-loading">
                  Sidebar loading…
                </div>,
              ),
            ],
          },
          "@panel": DescriptorPanel,
        }),
      ],
    ),

    // @sidebar opts out of streaming (loading: false) via slot descriptor;
    // @panel still gets the broadcast skeleton.
    path("/slot-opt-out", SlotOptOutPage, { name: "slotOptOut" }, () => [
      parallel(
        {
          "@sidebar": {
            handler: DescriptorSidebar,
            use: () => [loading(false)],
          },
          "@panel": DescriptorPanel,
        },
        () => [
          loading(
            <div data-testid="opt-out-broadcast-loading">
              Broadcast loading…
            </div>,
          ),
        ],
      ),
    ]),

    // Three-layer merge regression: all three layers must flow through to
    // the slot entry so the handler can ctx.use() each loader and render
    // all three marks. Each layer is observable — if any layer regresses,
    // one of the three data-testid spans disappears from the DOM.
    path("/three-layer", ThreeLayerPage, { name: "threeLayer" }, () => [
      parallel(
        {
          "@sidebar": {
            handler: ThreeLayerSidebar,
            // slot-local layer
            use: () => [loader(ThreeLayerSlotLocalLoader)],
          },
        },
        // shared layer (broadcast, but only one slot here)
        () => [loader(ThreeLayerSharedLoader)],
      ),
    ]),

    // Loader handler.use: revalidate rule attached on the loader definition
    // must reach the loader entry so the router invokes it during an
    // action-triggered revalidation. The page renders the rule's call count.
    path("/loader-use", LoaderHandlerUsePage, { name: "loaderUse" }, () => [
      loader(StableLoader),
    ]),

    // Intercept handler.use: middleware attached on the intercept handler must
    // flow through to the intercept entry so it runs when the intercept fires.
    // The handler reads the mw-set ctx var; if handler.use is ignored, the
    // rendered value is "NO-VALUE" instead of "intercept-mw-ran".
    layout(InterceptModalLayout, () => [
      path("/intercept-source", InterceptSourcePage, {
        name: "interceptSource",
      }),
      path("/intercept-target", InterceptTargetPage, {
        name: "interceptTarget",
      }),
      intercept("@modal", ".interceptTarget", InterceptedModal, () => [
        when(({ from }) =>
          from.pathname.startsWith("/handler-use/intercept-source"),
        ),
      ]),
    ]),
  ]),
]);
