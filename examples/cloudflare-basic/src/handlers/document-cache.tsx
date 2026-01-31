import { map, Meta } from "@ivogt/rsc-router/server";
import type { documentCacheRoutes } from "../routes.js";
import { RootLayout } from "../components/RootLayout.js";

/**
 * Async data component with 2 second delay.
 * Tests document-level caching of full responses.
 *
 * Cache behavior (based on Cache-Control headers):
 * - First request: MISS, takes ~2s
 * - Second request (within 60s): HIT, instant
 * - Request after 60s but within 360s: STALE, instant + background revalidation
 */
async function SlowDataComponent() {
  const renderTime = new Date().toISOString();

  // Simulate slow data fetch (2 seconds)
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return (
    <div
      data-testid="slow-data"
      className="p-4 bg-gray-100 rounded-lg dark:bg-gray-800"
    >
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
        Rendered at: <span data-testid="render-time">{renderTime}</span>
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        This component has a 2s delay. Cached requests show the same render
        time.
      </p>
    </div>
  );
}

export default map<typeof documentCacheRoutes>(({ route, layout }) => [
  layout(<RootLayout />, () => [
    route("documentCache", (ctx) => {
      const meta = ctx.use(Meta);
      meta({ title: "Document Cache Test - RSC Router" });

      // Opt-in to document caching via Cache-Control header
      // s-maxage=60: Cache for 60 seconds
      // stale-while-revalidate=300: Serve stale for 5 more minutes while revalidating
      ctx.header("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

      return (
        <main className="max-w-2xl mx-auto p-8" data-testid="document-cache-page">
          <h1 className="text-3xl font-bold mb-4">Document Cache Test</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            This page tests document-level caching. The entire HTTP response is
            cached at the edge based on Cache-Control headers.
          </p>

          <div className="mb-6 p-4 bg-blue-50 rounded-lg dark:bg-blue-900/20">
            <h2 className="font-semibold mb-2">How it works:</h2>
            <ul className="list-disc list-inside text-sm space-y-1">
              <li>
                <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">
                  s-maxage=60
                </code>{" "}
                - Fresh for 60 seconds
              </li>
              <li>
                <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">
                  stale-while-revalidate=300
                </code>{" "}
                - Serve stale for 5 more minutes
              </li>
            </ul>
          </div>

          <div className="mb-6 p-4 bg-yellow-50 rounded-lg dark:bg-yellow-900/20">
            <h2 className="font-semibold mb-2">Check response headers:</h2>
            <ul className="list-disc list-inside text-sm space-y-1">
              <li>
                <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">
                  x-document-cache-status: HIT
                </code>{" "}
                - Served from cache
              </li>
              <li>
                <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">
                  x-document-cache-status: STALE
                </code>{" "}
                - Stale, revalidating in background
              </li>
              <li>
                <code className="bg-gray-200 dark:bg-gray-700 px-1 rounded">
                  x-document-cache-status: MISS
                </code>{" "}
                - Not in cache, fresh render
              </li>
            </ul>
          </div>

          <SlowDataComponent />
        </main>
      );
    }),
  ]),
]);
