import { urls } from "@rangojs/router";
import { incrementHandlerExecutions } from "../manifest-cache-probe.js";

/**
 * Manifest cache test patterns.
 *
 * The urls() callback runs inside loadManifest(). After the first
 * request, the manifest is cached at module level and this callback
 * should NOT execute again within the same isolate.
 *
 * incrementHandlerExecutions() is called at DSL evaluation time (not at
 * request time), so the counter reflects how many times loadManifest()
 * actually ran the handler.
 */
export const manifestCacheTestPatterns = urls(({ path }) => {
  incrementHandlerExecutions();

  return [
    path(
      "/",
      () => (
        <div data-testid="manifest-cache-test-page">
          <h1>Manifest Cache Test</h1>
        </div>
      ),
      { name: "index" },
    ),
  ];
});
