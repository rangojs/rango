import {
  urls,
  cookies,
  createLoader,
  getRequestContext,
  type HandlerContext,
} from "@rangojs/router";

/**
 * A "use cache" function reading a loader something else started (#1011),
 * fetched by e2e/use-cache-memoized-loader.test.ts. The entry is keyed by
 * route and URL, not the visitor cookie the loader reads:
 *
 * - /handler-first: the handler reads VisitorLoader, then calls the cached
 *   function, which reads the memoized value. It refuses into the error
 *   boundary for every visitor instead of storing visitor a's value.
 * - /binding: the route's loader() binding starts VisitorLoader; same.
 * - /request-context: the handler and the cached function both read it with
 *   getRequestContext().use(), the request context's own loader runner; same.
 * - /plain: the same shape with a loader that reads no cookie; the entry is
 *   stored and served to every visitor.
 */

// Exported: the loader transform registers exported createLoader declarations.
export const UcmVisitorLoader = createLoader(
  async () => `visitor-${cookies().get("visitor")?.value ?? "none"}`,
);

export const UcmPlainLoader = createLoader(async () => "plain");

async function greetingFor(ctx: HandlerContext): Promise<string> {
  "use cache";
  return `greeting-for-${await ctx.use(UcmVisitorLoader)}`;
}

/** `probe` keys the entry per test. */
async function requestContextGreeting(probe: string): Promise<string> {
  "use cache";
  return `greeting-for-${await getRequestContext().use(UcmVisitorLoader)}:${probe}`;
}

async function RequestContextPage(ctx: HandlerContext) {
  const live = await getRequestContext().use(UcmVisitorLoader);
  const greeting = await requestContextGreeting(
    ctx.searchParams.get("probe") ?? "",
  );
  return <p data-testid="use-cache-memo">{`live-${live}|${greeting}`}</p>;
}

async function plainGreeting(ctx: HandlerContext): Promise<string> {
  "use cache";
  return `plain-greeting-${await ctx.use(UcmPlainLoader)}@${Date.now()}-${Math.random()}`;
}

async function HandlerFirstPage(ctx: HandlerContext) {
  const live = await ctx.use(UcmVisitorLoader);
  return (
    <p data-testid="use-cache-memo">{`live-${live}|${await greetingFor(ctx)}`}</p>
  );
}

async function BindingPage(ctx: HandlerContext) {
  return <p data-testid="use-cache-memo">{await greetingFor(ctx)}</p>;
}

async function PlainPage(ctx: HandlerContext) {
  await ctx.use(UcmPlainLoader);
  return <p data-testid="use-cache-memo">{await plainGreeting(ctx)}</p>;
}

function MemoError(props: { error: Error }) {
  return (
    <p data-testid="use-cache-memo-error">{`error: ${props.error.message}`}</p>
  );
}

export const useCacheMemoPatterns = urls(({ path, loader, errorBoundary }) => [
  path("/handler-first", HandlerFirstPage, { name: "handlerFirst" }, () => [
    errorBoundary(MemoError),
  ]),
  path("/binding", BindingPage, { name: "binding" }, () => [
    loader(UcmVisitorLoader),
    errorBoundary(MemoError),
  ]),
  path(
    "/request-context",
    RequestContextPage,
    { name: "requestContext" },
    () => [errorBoundary(MemoError)],
  ),
  path("/plain", PlainPage, { name: "plain" }, () => [
    errorBoundary(MemoError),
  ]),
]);
