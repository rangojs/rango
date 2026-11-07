import {
  createLoader,
  notFound,
  redirect,
  RouterError,
  urls,
} from "@rangojs/router";

/**
 * What a stale entry's refresh does with each answer
 * (tests/shared-e2e/src/refresh-outcome-scenario.ts). Each record, named by
 * `:k`, answers what /refresh-outcome/set last set for it: its page,
 * notFound(), redirect() or an error. Every cache here is fresh for 1 s and
 * then stale for 60 s, on the app's CFCacheStore.
 *
 * - /doc/:k: the document cache (router.tsx), opted in by Cache-Control.
 * - /route/:k: route cache().
 * - /loader/:k: a loader's cache(), read by the handler.
 * - /api/:k: a response route's cache(); its not-found is a 404 RouterError.
 */

type Outcome = "page" | "notFound" | "redirect" | "error";

const outcomes = new Map<string, Outcome>();

function answer(k: string): void {
  const outcome = outcomes.get(k) ?? "page";
  if (outcome === "notFound") notFound(`record ${k} deleted`);
  if (outcome === "redirect") throw redirect("/refresh-outcome/moved");
  if (outcome === "error") throw new Error(`record ${k} upstream down`);
}

export const RefreshOutcomeLoader = createLoader(async (ctx) => {
  answer(ctx.params.k);
  return { label: `record-loaded:${ctx.params.k}` };
});

const NotFound = <p data-testid="refresh-outcome-not-found">not found</p>;

export const refreshOutcomePatterns = urls(
  ({ path, cache, loader, notFoundBoundary }) => [
    path.json(
      "/set/:k/:to",
      (ctx) => {
        outcomes.set(ctx.params.k, ctx.params.to as Outcome);
        return { k: ctx.params.k, to: ctx.params.to };
      },
      { name: "set" },
    ),
    path("/moved", () => <p data-testid="refresh-outcome-moved">moved</p>, {
      name: "moved",
    }),

    path(
      "/doc/:k",
      (ctx) => {
        ctx.headers.set(
          "Cache-Control",
          "s-maxage=1, stale-while-revalidate=60",
        );
        answer(ctx.params.k);
        return <p data-testid="refresh-outcome-page">record-page</p>;
      },
      { name: "doc" },
      () => [notFoundBoundary(NotFound)],
    ),

    cache({ ttl: 1, swr: 60 }, () => [
      path(
        "/route/:k",
        (ctx) => {
          answer(ctx.params.k);
          return <p data-testid="refresh-outcome-page">record-page</p>;
        },
        { name: "route" },
        () => [notFoundBoundary(NotFound)],
      ),
    ]),

    path(
      "/loader/:k",
      async (ctx) => {
        const { label } = await ctx.use(RefreshOutcomeLoader);
        return <p data-testid="refresh-outcome-page">{label}</p>;
      },
      { name: "loader" },
      () => [
        loader(RefreshOutcomeLoader, () => [cache({ ttl: 1, swr: 60 })]),
        notFoundBoundary(NotFound),
      ],
    ),

    cache({ ttl: 1, swr: 60 }, () => [
      path.json(
        "/api/:k",
        (ctx) => {
          if (outcomes.get(ctx.params.k) === "notFound") {
            throw new RouterError("NOT_FOUND", `record ${ctx.params.k}`, {
              status: 404,
            });
          }
          answer(ctx.params.k);
          return { label: "record-json" };
        },
        { name: "api" },
      ),
    ]),
  ],
);
