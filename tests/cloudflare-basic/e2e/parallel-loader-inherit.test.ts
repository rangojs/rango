import { test } from "@playwright/test";
import { runParallelLoaderInheritHeldTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A held route loader read from a child layout's parallel slot: the layout
 * keeps its state across an action, a same-route navigation and Back
 * (rango-t156). Body: tests/shared-e2e/src/parallel-loader-inherit-held-scenario.ts.
 */
function describeParallelLoaderInherit(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`parallel loader inherit (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runParallelLoaderInheritHeldTests({
      url: (pathname) => f.url(pathname),
    });
  });
}

describeParallelLoaderInherit("dev");
describeParallelLoaderInherit("build");
