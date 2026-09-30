import {
  getRequestContext,
  type HandlerContext,
  type Middleware,
} from "@rangojs/router";

/**
 * The raw request-identity reads (#976) on workerd, fetched only by
 * e2e/identity-raw-reads.test.ts. `ctx.request.headers` and
 * `getRequestContext().cookie()` / `.cookies()` refuse where `cookies()`
 * does:
 *
 * - /identity-raw/ppr: the handler reads the x-visitor header on a ppr route,
 *   so the capture refuses and every visitor gets a MISS rendered with their
 *   own value. /identity-raw/ppr-control reads nothing and warms to a HIT.
 * - /identity-raw/cached?read=headers|cookie|cookies: the read inside a
 *   cache() boundary throws into the error boundary for every visitor.
 * - /identity-raw/use-cache: a "use cache" body reads ctx.request.headers and
 *   throws. /identity-raw/use-cache-arg reads the header in the handler and
 *   passes it in, so it keys the entry.
 * - /identity-raw/keyed: a cache() key() reads the header and partitions the
 *   record.
 * - /identity-raw/copies: new Request(ctx.request), ctx.request.clone() and
 *   fetch(ctx.request) inside a cache() boundary. The fetch goes back to the
 *   route; its middleware (answerForwarded) answers with the forwarded header.
 */

export function visitorOf(ctx: { request: Request }): string {
  return ctx.request.headers.get("x-visitor") ?? "none";
}

/** Left off the public type (use cookies()), reachable at runtime. */
interface RawCookieReads {
  cookie(name: string): string | undefined;
  cookies(): Record<string, string>;
}

export function IdentityRawPprPage(ctx: HandlerContext) {
  return (
    <p data-testid="identity-raw-ppr">{`ppr-visitor-is-${visitorOf(ctx)}`}</p>
  );
}

export function IdentityRawPprControlPage() {
  return <p data-testid="identity-raw-ppr-control">control</p>;
}

export function IdentityRawCachedPage(ctx: HandlerContext) {
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
  return `uc-arg-visitor-is-${visitor}@${crypto.randomUUID()}`;
}

export async function IdentityRawUseCachePage(ctx: HandlerContext) {
  return (
    <p data-testid="identity-raw-use-cache">
      {await cachedVisitorFromHeaders(ctx)}
    </p>
  );
}

export async function IdentityRawUseCacheArgPage(ctx: HandlerContext) {
  const visitor = `${visitorOf(ctx)}:${ctx.searchParams.get("probe") ?? ""}`;
  return (
    <p data-testid="identity-raw-use-cache-arg">
      {await cachedVisitor(visitor)}
    </p>
  );
}

export function IdentityRawKeyedPage() {
  return (
    <p data-testid="identity-raw-keyed">{`stamp-${crypto.randomUUID()}`}</p>
  );
}

/** Nonces of the requests IdentityRawCopiesPage forwarded with fetch(ctx.request). */
const forwarded = new Set<string>();

export const answerForwarded: Middleware = async (ctx, next) => {
  if (forwarded.delete(ctx.url.searchParams.get("nonce") ?? "")) {
    return new Response(`echo-${visitorOf(ctx)}`);
  }
  return next();
};

/** Each copy reports its result or the error it threw. */
export async function IdentityRawCopiesPage(ctx: HandlerContext) {
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

export function IdentityRawError(props: { error: Error }) {
  return (
    <p data-testid="identity-raw-error">{`error: ${props.error.message}`}</p>
  );
}
