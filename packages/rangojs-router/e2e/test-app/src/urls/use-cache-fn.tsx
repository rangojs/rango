import { Breadcrumbs } from "../handles.js";

// Function-level "use cache" — each function has its own directive.

/**
 * Cached data function used inside a createLoader.
 * Proves that "use cache" works through the loader layer.
 */
export async function getCachedLoaderData(): Promise<{
  ts: number;
  rand: number;
}> {
  "use cache";
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * Named cache profile. Uses "use cache: short" which maps to the
 * "short" profile configured in createRouter({ cacheProfiles }).
 */
export async function getShortCachedData(): Promise<{
  ts: number;
  rand: number;
}> {
  "use cache: short";
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * Receives tainted ctx (HandlerContext) and pushes breadcrumb handles.
 * ctx is excluded from the cache key. On cache hit, handles are replayed
 * so breadcrumbs still appear.
 */
export async function fetchWithBreadcrumbs(
  ctx: any,
): Promise<{ ts: number; rand: number }> {
  "use cache";
  const pushBreadcrumb = ctx.use(Breadcrumbs);
  pushBreadcrumb({
    label: "Cached Page",
    href: "/use-cache-test/with-handles",
  });
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * Slow cached data function for streaming test.
 * Takes 500ms on cache miss, instant on cache hit.
 */
export async function getSlowCachedData(): Promise<{
  ts: number;
  rand: number;
}> {
  "use cache";
  await new Promise((r) => setTimeout(r, 500));
  return { ts: Date.now(), rand: Math.random() };
}

/**
 * Cached function that returns a React node (JSX) instead of plain data.
 * Has an internal await to verify async cache serialization works,
 * and the returned Promise<ReactNode> streams through a loading() boundary.
 *
 * Tests that RSC Flight serialize/deserialize roundtrip handles JSX
 * through the cache correctly.
 */
export async function getCachedReactNode(): Promise<React.ReactNode> {
  "use cache";
  await new Promise((r) => setTimeout(r, 200));
  const ts = Date.now();
  const rand = Math.random();
  return (
    <>
      <span data-testid="cached-node-ts">{ts}</span>
      <span data-testid="cached-node-rand">{rand}</span>
    </>
  );
}
