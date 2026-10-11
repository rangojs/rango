import { test } from "@playwright/test";
import { runHeldHandlesTests } from "@shared/e2e";
import { useFixture } from "./fixture";

/**
 * A loader whose rerun an action skips keeps its handle pushes; a rerun
 * replaces them (#1103). Body: tests/shared-e2e/src/held-handles-scenario.ts.
 */
function describeHeldHandles(mode: "dev" | "build") {
  const label = mode === "build" ? "production" : "dev";
  test.describe(`held loader handles (${label})`, () => {
    const f = useFixture({ root: ".", mode });
    runHeldHandlesTests({
      url: (pathname) => f.url(pathname),
      clientPath: "/held-handles-client",
      serverPath: "/held-handles-server",
    });
  });
}

describeHeldHandles("dev");
describeHeldHandles("build");
