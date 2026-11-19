import { test } from "@playwright/test";
import { runNotReusedNoStoreTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A route's `no-store` is kept on the partials nothing may reuse (a scoped
 * prefetch, a deferring prefetch, its fill, a stale partial); a route that
 * sets nothing gets `private, no-cache`. Headers only, from the response
 * event. Body: tests/shared-e2e/src/not-reused-no-store-scenario.ts.
 */
function describeNotReusedNoStore(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`a route's no-store on not-reused partials (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runNotReusedNoStoreTests({ url: (pathname) => f.url(pathname) });
  });
}

describeNotReusedNoStore("dev");
describeNotReusedNoStore("build");
