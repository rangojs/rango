import { urls, cookies, createLoader } from "@rangojs/router";

/**
 * ppr header-write guard fixtures (issue #713 doctrine: ppr is a
 * document-scoped cache() — in cached scenarios only middleware writes
 * headers).
 *
 * - /handler: ppr route whose HANDLER calls ctx.headers.set — the unified
 *   guard throws deterministically on every render (dev and prod).
 * - /loader: ppr route whose DSL LOADER calls cookies().set — same guard,
 *   loader wording (headers flush with the shell before loaders settle).
 * - /mw-live: the positive control. Route middleware sets a static header, a
 *   per-request header, and a session cookie on a ppr route — all three must
 *   ride MISS and HIT responses alike (middleware is THE live header lane).
 * - /mw-post-next: the POST-NEXT lane. Route middleware writes AFTER
 *   `await next()` on a ppr route — pins that the guard latch dies with the
 *   funnel scope (runWithStore never copies cachedHeaderScope), so post-next
 *   middleware writes neither throw nor get dropped, on MISS and HIT alike.
 *
 * Each guard route carries its own errorBoundary and is only fetched by its
 * own test, so the deterministic failure cannot leak into other suites.
 */

// Live hole for the mw-live shell; seq proves the loader stays live on HITs.
// Exported module-level consts: the build plugin only injects loader $$ids on
// exported createLoader declarations.
let mwLiveSeq = 0;
export const MwLiveLoader = createLoader(async (): Promise<{ seq: number }> => {
  mwLiveSeq += 1;
  return { seq: mwLiveSeq };
});

let mwLiveRequestSeq = 0;

// Live hole for the mw-post-next shell (separate from MwLiveLoader so the two
// routes' seq counters stay independent).
let mwPostNextSeq = 0;
export const MwPostNextLoader = createLoader(
  async (): Promise<{ seq: number }> => {
    mwPostNextSeq += 1;
    return { seq: mwPostNextSeq };
  },
);

export const PhgCookieWriterLoader = createLoader(
  async (): Promise<{
    wrote: boolean;
  }> => {
    cookies().set("phg-loader", "should-never-apply", { path: "/" });
    return { wrote: true };
  },
);

export const pprHeaderGuardPatterns = urls(
  ({ path, loader, loading, middleware, errorBoundary }) => [
    errorBoundary((props) => (
      <div data-testid="phg-error-page">
        <span data-testid="phg-error-message">{props.error.message}</span>
      </div>
    )),
    // HANDLER header write on a ppr route — guard throws on every render.
    path(
      "/handler",
      (ctx) => {
        ctx.headers.set("X-PHG-Handler", "should-never-apply");
        return <div data-testid="phg-handler-page">Should not render</div>;
      },
      { name: "handler", ppr: true },
    ),
    // LOADER cookie write on a ppr route — guard throws with loader wording.
    // The handler awaits the loader (no loading() hole) so the rejection
    // surfaces at segment resolution on EVERY render — foreground and capture
    // alike — and the route fails deterministically instead of streaming an
    // error into a hole.
    path(
      "/loader",
      async (ctx) => {
        await ctx.use(PhgCookieWriterLoader);
        return <div data-testid="phg-loader-page">Should not render</div>;
      },
      { name: "loader", ppr: true },
      () => [loader(PhgCookieWriterLoader)],
    ),
    // POSITIVE CONTROL: middleware headers + cookie stay live on MISS and HIT.
    middleware(
      async (ctx, next) => {
        mwLiveRequestSeq += 1;
        ctx.headers.set("X-PHG-MW", "static-value");
        ctx.headers.set("X-PHG-MW-Seq", String(mwLiveRequestSeq));
        cookies().set("phg_mw_session", "live-cookie", { path: "/" });
        return next();
      },
      () => [
        path(
          "/mw-live",
          () => (
            <main data-testid="phg-mw-live-page">
              <p data-testid="phg-mw-live-static">MW live shell</p>
            </main>
          ),
          { name: "mwLive", ppr: { ttl: 300, swr: 120 } },
          () => [
            loader(MwLiveLoader),
            loading(<div data-testid="phg-mw-live-fallback">Loading...</div>),
          ],
        ),
      ],
    ),
    // POST-NEXT lane: writes AFTER `await next()` — the ppr render inside
    // next() latched the guard, but the latch dies with the funnel scope, so
    // these must neither throw nor be dropped (MISS and HIT alike).
    middleware(
      async (ctx, next) => {
        const res = await next();
        cookies().set("phg_post_next", "1", { path: "/" });
        ctx.header("X-PHG-Post-Next", "1");
        return res;
      },
      () => [
        path(
          "/mw-post-next",
          () => (
            <main data-testid="phg-mw-post-next-page">
              <p>MW post-next shell</p>
            </main>
          ),
          { name: "mwPostNext", ppr: { ttl: 300, swr: 120 } },
          () => [
            loader(MwPostNextLoader),
            loading(
              <div data-testid="phg-mw-post-next-fallback">Loading...</div>,
            ),
          ],
        ),
      ],
    ),
  ],
);
