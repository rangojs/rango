// Loaders and run counters for serve-shell-request-loader-meta-promise
// .rsc-test.tsx (#1182). In a module of their own: the clientUrls() group in
// loader-meta-promise-client-urls.tsx is a "use client" module.
import {
  createLoader,
  Meta,
  type LoaderDefinition,
} from "../../../index.rsc.js";
import { source } from "./shell-request-data.js";

/** Body runs, across requests of one test. */
export const metaRuns: {
  grid: number;
  awaited: number;
  source: number;
} = {
  grid: 0,
  awaited: 0,
  source: 0,
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
