import type { ReactNode } from "react";
import {
  createLoader,
  Prerender,
  urls,
  type Handler,
  type Middleware,
} from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";

// A prefetch answer with nothing live in it (every sent segment
// stored, no loader) carries the router's prefetch Cache-Control. Each page
// renders a stamp, so a test tells a stored answer from a fresh render. ?k
// keys the records and documents to one test. router.tsx mounts the document
// cache on /prefetch-stored/doc/*. Body:
// tests/shared-e2e/src/prefetch-stored-scenario.ts.

const BASE = "/prefetch-stored";

export const PrefetchStoredLoader = createLoader(async () => ({
  ran: `loader:${Date.now()}`,
}));

const stamp = (): string =>
  `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

const cacheForAMinute: Middleware = async (ctx, next) => {
  ctx.header("Cache-Control", "s-maxage=60");
  await next();
};

/** A page that renders its name and a fresh stamp. */
const page =
  (name: string): Handler =>
  () => <p data-testid="ps-page">{`ps-stamp:${name}:${stamp()}`}</p>;

function PrefetchStoredNav({ k }: { k: string | null }): ReactNode {
  const to = (path: string) => `${BASE}${path}?k=${k ?? ""}`;
  return (
    <nav>
      {(
        [
          ["cached", "/cached"],
          ["cached-loader", "/cached-loader"],
          ["section-b", "/section/b"],
          ["baked", "/baked"],
          ["doc", "/doc/page"],
        ] as const
      ).map(([name, path]) => (
        <Link
          key={name}
          to={to(path)}
          prefetch="hover"
          data-testid={`ps-to-${name}`}
        >
          {name}
        </Link>
      ))}
    </nav>
  );
}

const PrefetchStoredBaked = Prerender(() => (
  <p data-testid="ps-page">ps-stamp:baked:static</p>
));

export const prefetchStoredPatterns = urls(
  ({ cache, layout, loader, middleware, path }) => [
    layout(
      (ctx) => (
        <div>
          <PrefetchStoredNav k={ctx.searchParams.get("k")} />
          <Outlet />
        </div>
      ),
      () => [
        path("/home", page("home"), { name: "home" }),
        cache({ ttl: 300 }, () => [
          path("/cached", page("cached"), { name: "cached" }),
          path(
            "/cached-loader",
            page("cached-loader"),
            { name: "cachedLoader" },
            () => [loader(PrefetchStoredLoader)],
          ),
        ]),
        // A live layout above a cache() boundary: sent live unless the
        // client holds it.
        layout(
          () => (
            <section data-testid="ps-section">
              <Outlet />
            </section>
          ),
          () => [
            cache({ ttl: 300 }, () => [
              path("/section/a", page("section-a"), { name: "sectionA" }),
              path("/section/b", page("section-b"), { name: "sectionB" }),
            ]),
          ],
        ),
        path("/baked", PrefetchStoredBaked, { name: "baked" }),
        path("/doc/page", page("doc"), { name: "doc" }, () => [
          middleware(cacheForAMinute),
          loader(PrefetchStoredLoader),
        ]),
      ],
    ),
  ],
);
