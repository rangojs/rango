import {
  urls,
  getRequestContext,
  type HandlerContext,
  type Middleware,
} from "@rangojs/router";

/**
 * The raw request-identity reads (#976), fetched by
 * e2e/identity-raw-reads.test.ts. `ctx.request.headers` and
 * `getRequestContext().cookie()` / `.cookies()` refuse where `cookies()`
 * does:
 *
 * - /ppr: the handler reads the x-visitor header on a ppr route, so the
 *   capture refuses and every visitor gets a MISS rendered with their own
 *   value. /ppr-control reads nothing and warms to a HIT.
 * - /cached?read=headers|cookie|cookies: the read inside a cache() boundary
 *   throws into the error boundary for every visitor.
 * - /use-cache: a "use cache" body reads ctx.request.headers and throws.
 *   /use-cache-arg reads the header in the handler (outside any cached scope)
 *   and passes it in, so it keys the entry.
 * - /keyed: a cache() key() reads the header and partitions the record.
 * - /copies: new Request(ctx.request), ctx.request.clone() and
 *   fetch(ctx.request) inside a cache() boundary. The fetch goes back to this
 *   route; the route middleware answers it with the forwarded header.
 */

function visitorOf(ctx: { request: Request }): string {
  return ctx.request.headers.get("x-visitor") ?? "none";
}

/** Left off the public type (use cookies()), reachable at runtime. */
interface RawCookieReads {
  cookie(name: string): string | undefined;
  cookies(): Record<string, string>;
}

function PprPage(ctx: HandlerContext) {
  return (
    <p data-testid="identity-raw-ppr">{`ppr-visitor-is-${visitorOf(ctx)}`}</p>
  );
}

function PprControlPage() {
  return <p data-testid="identity-raw-ppr-control">control</p>;
}

function CachedReadPage(ctx: HandlerContext) {
  const read = ctx.searchParams.get("read");
  const raw = getRequestContext() as unknown as RawCookieReads;
  const value =
    read === "cookie"
      ? raw.cookie("visitor")
      : read === "cookies"
        ? raw.cookies().visitor
        : visitorOf(ctx);
  return (
    <p data-testid="identity-raw-cached-value">{`cached-visitor-is-${value}`}</p>
  );
}

async function cachedVisitorFromHeaders(ctx: HandlerContext): Promise<string> {
  "use cache";
  return `uc-visitor-is-${visitorOf(ctx)}`;
}

async function cachedVisitor(visitor: string): Promise<string> {
  "use cache";
  return `uc-arg-visitor-is-${visitor}@${Date.now()}-${Math.random()}`;
}

let keyedRenders = 0;

function KeyedPage() {
  keyedRenders += 1;
  return <p data-testid="identity-raw-keyed">{`stamp-${keyedRenders}`}</p>;
}

/** Nonces of the requests CopiesPage forwarded with fetch(ctx.request). */
const forwarded = new Set<string>();

const answerForwarded: Middleware = async (ctx, next) => {
  if (forwarded.delete(ctx.url.searchParams.get("nonce") ?? "")) {
    return new Response(`echo-${visitorOf(ctx)}`);
  }
  return next();
};

/**
 * Each copy reports its result or the error it threw. None may throw the
 * identity guard's error. On Node the dev and preview servers hand the router
 * srvx's lazy NodeRequest, which undici's Request constructor and fetch()
 * reject ("reading 'window'"): a srvx/undici gap that predates #976, so the
 * Node suite pins clone() and the absence of a guard error.
 */
async function CopiesPage(ctx: HandlerContext) {
  const nonce = ctx.searchParams.get("nonce") ?? "";
  const results: string[] = [];
  const attempt = async (label: string, op: () => unknown) => {
    try {
      results.push(`${label}:${await op()}`);
    } catch (error) {
      results.push(`${label}:threw:${(error as Error).message}`);
    }
  };
  await attempt("copy", () => new Request(ctx.request).method);
  await attempt("clone", () => ctx.request.clone().url === ctx.request.url);
  forwarded.add(nonce);
  await attempt("fetch", async () => (await fetch(ctx.request)).text());
  forwarded.delete(nonce);
  return <p data-testid="identity-raw-copies">{results.join(" ")}</p>;
}

function RawReadError(props: { error: Error }) {
  return (
    <p data-testid="identity-raw-error">{`error: ${props.error.message}`}</p>
  );
}

export const identityRawPatterns = urls(
  ({ path, cache, errorBoundary, middleware }) => [
    path("/ppr", PprPage, { name: "ppr", ppr: true }),
    path("/ppr-control", PprControlPage, { name: "pprControl", ppr: true }),
    cache({ ttl: 300 }, () => [
      path("/cached", CachedReadPage, { name: "cached" }, () => [
        errorBoundary(RawReadError),
      ]),
    ]),
    middleware(answerForwarded, () => [
      cache({ ttl: 300 }, () => [
        path("/copies", CopiesPage, { name: "copies" }),
      ]),
    ]),
    path(
      "/use-cache",
      async (ctx: HandlerContext) => (
        <p data-testid="identity-raw-use-cache">
          {await cachedVisitorFromHeaders(ctx)}
        </p>
      ),
      { name: "useCache" },
      () => [errorBoundary(RawReadError)],
    ),
    path(
      "/use-cache-arg",
      async (ctx: HandlerContext) => (
        <p data-testid="identity-raw-use-cache-arg">
          {await cachedVisitor(
            `${visitorOf(ctx)}:${ctx.searchParams.get("probe") ?? ""}`,
          )}
        </p>
      ),
      { name: "useCacheArg" },
    ),
    cache(
      {
        ttl: 300,
        key: (ctx) =>
          `visitor:${visitorOf(ctx)}:${ctx.url.searchParams.get("probe") ?? ""}`,
      },
      () => [path("/keyed", KeyedPage, { name: "keyed" })],
    ),
  ],
);
