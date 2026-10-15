// Loaders and run counters for serve-shell-request-loader-meta-promise
// .rsc-test.tsx (#1182). In a module of their own: the clientUrls() group in
// loader-meta-promise-client-urls.tsx is a "use client" module.
import {
  cacheTag,
  createHandle,
  createLoader,
  Meta,
  type Handle,
  type LoaderDefinition,
} from "../../../index.rsc.js";
import { _getRequestContext } from "../../../server/request-context.js";
import { source } from "./shell-request-data.js";

/** Body runs, across requests of one test. */
export const metaRuns: {
  grid: number;
  awaited: number;
  source: number;
  hole: number;
  dep: number;
  defer: number;
  nullTitle: number;
  product: number;
} = {
  grid: 0,
  awaited: 0,
  source: 0,
  hole: 0,
  dep: 0,
  defer: 0,
  nullTitle: 0,
  product: 0,
};

interface GridPayload {
  seo: { title: string } | undefined;
  data: { grid: string };
}

async function loadGrid(): Promise<GridPayload> {
  return {
    seo: { title: `grid-title@g${source.generation}` },
    data: { grid: `grid@g${source.generation}` },
  };
}

/** The issue's loader: the title is pushed to Meta as a promise. */
export const GridLoader: LoaderDefinition<{ grid: string }> = createLoader(
  async (ctx) => {
    metaRuns.grid += 1;
    const payload = await loadGrid();
    ctx.use(Meta)(
      Promise.resolve(payload.seo).then((s) =>
        s?.title ? { title: s.title } : {},
      ),
    );
    return payload.data;
  },
);

/** The issue's workaround: the same value, awaited before the push. */
export const AwaitedGridLoader: LoaderDefinition<{ grid: string }> =
  createLoader(async (ctx) => {
    metaRuns.awaited += 1;
    const payload = await loadGrid();
    ctx.use(Meta)(
      await Promise.resolve(payload.seo).then((s) =>
        s?.title ? { title: s.title } : {},
      ),
    );
    return payload.data;
  });

/** A layout's ssr: false loader above the include (the #1179 shape). */
export const ChromeLoader: LoaderDefinition<{ chrome: string }> = createLoader(
  async () => ({ chrome: `chrome@g${source.generation}` }),
);

/**
 * A recipe that needs no router change: the payload is fetched once per
 * request by a dependency loader (no route registers it), whose data keeps
 * `seo` a promise. The page's loader returns the grid; a second `ssr: false`
 * loader awaits `seo` and pushes a settled title. On a document both are
 * awaited before the first flush; on a navigation each streams on its own,
 * and nothing reads the title loader, so the grid does not wait for `seo`.
 */
export const GridSource: LoaderDefinition<{
  data: { grid: string };
  seo: Promise<{ title: string } | undefined>;
}> = createLoader(async () => {
  metaRuns.source += 1;
  const payload = await loadGrid();
  return { data: payload.data, seo: Promise.resolve(payload.seo) };
});

export const RecipeGridLoader: LoaderDefinition<{ grid: string }> =
  createLoader(async (ctx) => (await ctx.use(GridSource)).data);

export const RecipeTitleLoader: LoaderDefinition<null> = createLoader(
  async (ctx) => {
    const seo = await (await ctx.use(GridSource)).seo;
    ctx.use(Meta)(seo?.title ? { title: seo.title } : {});
    return null;
  },
);

// ---------------------------------------------------------------------------
// The target design's cases (dc-t87): each loader below pushes its title to
// Meta as a promise in one more shape.
// ---------------------------------------------------------------------------

/** The title as the issue's loader pushes it: a promise of a descriptor. */
function titlePromise(title: string): Promise<{ title: string }> {
  return Promise.resolve({ title });
}

/** Its pushed promise rejects (an SEO service that is down). */
export const RejectingTitleLoader: LoaderDefinition<{ grid: string }> =
  createLoader(async (ctx) => {
    const payload = await loadGrid();
    const seo: Promise<{ title: string }> = Promise.reject(
      new Error("seo service down"),
    );
    seo.catch(() => {});
    ctx.use(Meta)(seo);
    return payload.data;
  });

/** Settles after SLOW_TITLE_MS, after the loader returned. */
export const SLOW_TITLE_MS = 300;
/** The ppr.captureTimeout the slow title's route sets: shorter than the push. */
export const SLOW_TITLE_CAPTURE_TIMEOUT_MS = 50;

export const SlowTitleLoader: LoaderDefinition<{ grid: string }> = createLoader(
  async (ctx) => {
    const payload = await loadGrid();
    const title = payload.seo!.title;
    ctx.use(Meta)(
      new Promise<{ title: string }>((resolve) =>
        setTimeout(() => resolve({ title }), SLOW_TITLE_MS),
      ),
    );
    return payload.data;
  },
);

/**
 * Its pushed promise settles to a value that holds a promise: once settled
 * the push is judged as a settled push would be, so it stays live.
 */
export const NestedTitleLoader: LoaderDefinition<{ grid: string }> =
  createLoader(async (ctx) => {
    const payload = await loadGrid();
    ctx.use(Meta)(
      Promise.resolve({
        title: payload.seo!.title,
        later: Promise.resolve("later"),
      } as unknown as { title: string }),
    );
    return payload.data;
  });

/**
 * Its data holds a promise (a hole, `holes: 1`), so its body runs on every
 * HIT; its title is a promise push.
 */
export const HoleTitleLoader: LoaderDefinition<{
  grid: string;
  reviews: Promise<string>;
}> = createLoader(async (ctx) => {
  metaRuns.hole += 1;
  const payload = await loadGrid();
  ctx.use(Meta)(titlePromise(payload.seo!.title));
  return {
    grid: payload.data.grid,
    reviews: Promise.resolve(`reviews@g${source.generation}`),
  };
});

/** A handle only NestedSideLoader pushes to. */
export const SideNotes: Handle<string> = createHandle<string>();

/**
 * Pushes a settled value that holds a promise: the record cannot keep it,
 * so the capture asks every loader record of the page to run (`runs: 1`).
 */
export const NestedSideLoader: LoaderDefinition<{ side: string }> =
  createLoader(async (ctx) => {
    ctx.use(SideNotes)({
      label: `side@g${source.generation}`,
      later: Promise.resolve("side-later"),
    } as unknown as string);
    return { side: `side@g${source.generation}` };
  });

/** Pushes through .defer(), resolved after the loader returned. */
export const DeferTitleLoader: LoaderDefinition<{ grid: string }> =
  createLoader(async (ctx) => {
    metaRuns.defer += 1;
    const resolve = ctx.use(Meta).defer();
    const payload = await loadGrid();
    const title = payload.seo!.title;
    setTimeout(() => resolve({ title }), 10);
    return payload.data;
  });

/** A dependency no route registers: it pushes the title as a promise. */
export const TitleDependency: LoaderDefinition<{ grid: string }> = createLoader(
  async (ctx) => {
    metaRuns.dep += 1;
    const payload = await loadGrid();
    ctx.use(Meta)(titlePromise(payload.seo!.title));
    return payload.data;
  },
);

/** The route's ssr: false loader: it awaits the dependency. */
export const DependentGridLoader: LoaderDefinition<{ grid: string }> =
  createLoader(async (ctx) => await ctx.use(TitleDependency));

/** Its pushed promise settles to `null`: a skipped slot (N1). */
export const NullTitleLoader: LoaderDefinition<{ grid: string }> = createLoader(
  async (ctx) => {
    metaRuns.nullTitle += 1;
    const payload = await loadGrid();
    ctx.use(Meta)(
      Promise.resolve(null) as unknown as Promise<{ title: string }>,
    );
    return payload.data;
  },
);

/**
 * The `.defer()` resolver a page component calls while it renders (N3), per
 * request context: a capture runs beside the request that scheduled it.
 */
const deferResolvers = new WeakMap<
  object,
  (value: { title: string }) => void
>();

/** The resolver ComponentDeferTitleLoader reserved on this request. */
export function deferResolver():
  | ((value: { title: string }) => void)
  | undefined {
  const reqCtx = _getRequestContext();
  return reqCtx ? deferResolvers.get(reqCtx) : undefined;
}

/** The fallback a `.defer()` slot resolves to when nothing resolves it. */
export const DEFER_ELSE_TITLE = "defer-else";
/** The slot's `timeoutMs`: shorter than the capture's deadline. */
export const DEFER_TIMEOUT_MS = 30;

/** Reserves a slot that the page component resolves (N3). */
export const ComponentDeferTitleLoader: LoaderDefinition<{ grid: string }> =
  createLoader(async (ctx) => {
    const resolve = ctx.use(Meta).defer({
      timeoutMs: DEFER_TIMEOUT_MS,
      else: { title: DEFER_ELSE_TITLE },
    });
    const reqCtx = _getRequestContext();
    if (reqCtx) deferResolvers.set(reqCtx, resolve);
    return (await loadGrid()).data;
  });

/** A "use cache" title, tagged with its product (N6). */
export async function getSeoTitle(id: string): Promise<{ title: string }> {
  "use cache";
  cacheTag(`seo:${id}`);
  return { title: `seo-title-${id}@g${source.generation}` };
}

/** Pushes the cached title as a promise (N6). */
export const CachedTitleLoader: LoaderDefinition<{ grid: string }> =
  createLoader(async (ctx) => {
    ctx.use(Meta)(getSeoTitle(ctx.params.id!));
    return (await loadGrid()).data;
  });

/** A handle only StockNoteLoader pushes to (N12). */
export const StockNotes: Handle<string> = createHandle<string>();

/**
 * The migration recipe (N12): the page's ssr: false loader pushes its title
 * as a promise, which bakes with its data.
 */
export const ProductLoader: LoaderDefinition<{ product: string }> =
  createLoader(async (ctx) => {
    metaRuns.product += 1;
    ctx.use(Meta)(titlePromise(`product-title@g${source.generation}`));
    return { product: `product@g${source.generation}` };
  });

/**
 * The migration recipe (N12): a live-lane loader that nothing reads pushes
 * the per-request value, so it stays live on a HIT.
 */
export const StockNoteLoader: LoaderDefinition<null> = createLoader(
  async (ctx) => {
    ctx.use(StockNotes)(Promise.resolve(`stock-note@g${source.generation}`));
    return null;
  },
);
