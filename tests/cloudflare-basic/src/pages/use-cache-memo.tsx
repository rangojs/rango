import {
  cookies,
  createLoader,
  getRequestContext,
  type HandlerContext,
} from "@rangojs/router";

/**
 * A "use cache" function reading a loader something else started (#1011) on
 * workerd, fetched only by e2e/use-cache-memoized-loader.test.ts. The entry
 * is keyed by route and URL, not the visitor cookie the loader reads:
 *
 * - /use-cache-memo/handler-first: the handler reads UcmVisitorLoader, then
 *   calls the cached function, which reads the memoized value. It refuses
 *   into the error boundary for every visitor instead of storing visitor a's
 *   value.
 * - /use-cache-memo/binding: the route's loader() binding starts it; same.
 * - /use-cache-memo/request-context: the handler and the cached function both
 *   read it with getRequestContext().use(), the request context's own loader
 *   runner; same.
 * - /use-cache-memo/plain: a loader that reads no cookie; the entry is
 *   stored and served to every visitor.
 */

export const UcmVisitorLoader = createLoader(
  async () => `visitor-${cookies().get("visitor")?.value ?? "none"}`,
);

export const UcmPlainLoader = createLoader(async () => "plain");

async function greetingFor(ctx: HandlerContext): Promise<string> {
  "use cache";
  return `greeting-for-${await ctx.use(UcmVisitorLoader)}`;
}

async function plainGreeting(ctx: HandlerContext): Promise<string> {
  "use cache";
  return `plain-greeting-${await ctx.use(UcmPlainLoader)}@${Date.now()}-${Math.random()}`;
}

export async function UcmHandlerFirstPage(ctx: HandlerContext) {
  const live = await ctx.use(UcmVisitorLoader);
  return (
    <p data-testid="use-cache-memo">{`live-${live}|${await greetingFor(ctx)}`}</p>
  );
}

export async function UcmBindingPage(ctx: HandlerContext) {
  return <p data-testid="use-cache-memo">{await greetingFor(ctx)}</p>;
}

/** `probe` keys the entry per test. */
async function requestContextGreeting(probe: string): Promise<string> {
  "use cache";
  return `greeting-for-${await getRequestContext().use(UcmVisitorLoader)}:${probe}`;
}

export async function UcmRequestContextPage(ctx: HandlerContext) {
  const live = await getRequestContext().use(UcmVisitorLoader);
  const greeting = await requestContextGreeting(
    ctx.searchParams.get("probe") ?? "",
  );
  return <p data-testid="use-cache-memo">{`live-${live}|${greeting}`}</p>;
}

export async function UcmPlainPage(ctx: HandlerContext) {
  await ctx.use(UcmPlainLoader);
  return <p data-testid="use-cache-memo">{await plainGreeting(ctx)}</p>;
}

export function UcmError(props: { error: Error }) {
  return (
    <p data-testid="use-cache-memo-error">{`error: ${props.error.message}`}</p>
  );
}
