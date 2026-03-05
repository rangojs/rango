import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Manifest cache e2e test.
 *
 * Verifies that the module-level manifest cache in loadManifest() prevents
 * re-execution of the DSL handler after the first request within the same
 * isolate. A dedicated route's DSL handler increments a module-level counter;
 * the /__test/manifest-cache-counter endpoint reads it.
 *
 * After hitting the route multiple times, the counter should remain at 1
 * (or at most 2 for SSR + non-SSR cache keys).
 */

test.describe("manifest cache (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
  });

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
    // Handler should have run at least once
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Second request to the same route
    const res2 = await request.get(f.url("/manifest-cache-test"));
    expect(res2.status()).toBe(200);

    // Third request
    const res3 = await request.get(f.url("/manifest-cache-test"));
    expect(res3.status()).toBe(200);

    // Counter should not have increased
    const counter2 = await request.get(f.url("/__test/manifest-cache-counter"));
    const data2 = await counter2.json();
    expect(data2.data.handlerExecutions).toBe(firstCount);
  });
});

test.describe("manifest cache (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  test("DSL handler runs only once across multiple requests", async ({
    request,
  }) => {
    // First request
    const res1 = await request.get(f.url("/manifest-cache-test"));
    expect(res1.status()).toBe(200);

    const counter1 = await request.get(f.url("/__test/manifest-cache-counter"));
    const data1 = await counter1.json();
    const firstCount = data1.data.handlerExecutions;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Second and third requests
    await request.get(f.url("/manifest-cache-test"));
    await request.get(f.url("/manifest-cache-test"));

    // Counter should not have increased
    const counter2 = await request.get(f.url("/__test/manifest-cache-counter"));
    const data2 = await counter2.json();
    expect(data2.data.handlerExecutions).toBe(firstCount);
  });
});
