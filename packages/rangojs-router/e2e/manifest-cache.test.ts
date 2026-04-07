import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Shared manifest cache tests run against both dev and production.
 *
 * Contract under test:
 * - DSL handler (urls() callback) runs only once per isolate
 * - After manifest is cached, route resolution still works for all routes
 * - Different routes share the same cached manifest
 */
function manifestCacheTests(f: ReturnType<typeof useFixture>) {
  test("DSL handler runs only once across multiple requests", async ({
    request,
  }) => {
    // First request: triggers loadManifest which runs the DSL handler
    const res1 = await request.get(f.url("/manifest-cache-test"));
    expect(res1.status()).toBe(200);

    // Read counter after first request
    const counter1 = await request.get(f.url("/__test/manifest-cache-counter"));
    const data1 = await counter1.json();
    const firstCount = data1.data.handlerExecutions;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Second and third requests to the same route
    const res2 = await request.get(f.url("/manifest-cache-test"));
    expect(res2.status()).toBe(200);
    const res3 = await request.get(f.url("/manifest-cache-test"));
    expect(res3.status()).toBe(200);

    // Counter should not have increased — manifest was cached
    const counter2 = await request.get(f.url("/__test/manifest-cache-counter"));
    const data2 = await counter2.json();
    expect(data2.data.handlerExecutions).toBe(firstCount);
  });

  test("cached manifest resolves different routes correctly", async ({
    request,
  }) => {
    // Hit the manifest-cache-test route first to warm the manifest
    const warmup = await request.get(f.url("/manifest-cache-test"));
    expect(warmup.status()).toBe(200);

    // Snapshot the counter after warmup
    const counterBefore = await request.get(
      f.url("/__test/manifest-cache-counter"),
    );
    const dataBefore = await counterBefore.json();
    const countBefore = dataBefore.data.handlerExecutions;

    // Now hit completely different routes — they should all resolve
    // from the same cached manifest, not trigger re-evaluation
    const home = await request.get(f.url("/"));
    expect(home.status()).toBe(200);

    const blog = await request.get(f.url("/blog"));
    expect(blog.status()).toBe(200);

    // Unknown route should still 404, not error
    const unknown = await request.get(f.url("/does-not-exist"));
    expect(unknown.status()).toBe(404);

    // Counter should not have increased — all routes used cached manifest
    const counterAfter = await request.get(
      f.url("/__test/manifest-cache-counter"),
    );
    const dataAfter = await counterAfter.json();
    expect(dataAfter.data.handlerExecutions).toBe(countBefore);
  });
}

test.describe("manifest cache (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

  manifestCacheTests(f);
});

test.describe("manifest cache (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test.setTimeout(120000);

  manifestCacheTests(f);
});
