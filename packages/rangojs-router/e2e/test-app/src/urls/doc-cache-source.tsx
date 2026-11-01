import {
  urls,
  type Handler,
  type Middleware,
  type Revalidate,
} from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

// rango-t238: a category layout renders the category's hero and re-renders
// only when the source page's category differs, above a PLP the document
// cache stores (router.tsx mounts the middleware on /doc-cache-source/*).
// From /c/audio, /c/audio?sort=x keeps the hero; from /c/tv, which holds the
// same ids, it must render the audio hero. ?k keys the entries to one test.
// Body: tests/shared-e2e/src/doc-cache-source-scenario.ts.

const revalidateHero: Revalidate = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) =>
  currentParams.category !== nextParams.category
    ? true
    : defaultShouldRevalidate;

const cacheForAMinute: Middleware = async (ctx, next) => {
  ctx.header("Cache-Control", "s-maxage=60");
  await next();
};

const DocCacheSourcePlp: Handler<"/c/:category"> = (ctx) => {
  const k = ctx.searchParams.get("k");
  return (
    <div>
      <p data-testid="dcs-page">{`plp:${ctx.params.category}:${ctx.searchParams.get("sort") ?? ""}`}</p>
      <Link
        to={`/doc-cache-source/c/audio?sort=x&k=${k}`}
        prefetch="none"
        data-testid="dcs-to-audio-sorted"
      >
        Audio, sorted
      </Link>
    </div>
  );
};

export const docCacheSourcePatterns = urls(
  ({ layout, path, middleware, revalidate }) => [
    layout(
      (ctx) => (
        <section>
          <p data-testid="dcs-hero">{`hero:${ctx.params.category}`}</p>
          <Outlet />
        </section>
      ),
      () => [
        revalidate(revalidateHero),
        path("/c/:category", DocCacheSourcePlp, () => [
          middleware(cacheForAMinute),
        ]),
      ],
    ),
  ],
);
