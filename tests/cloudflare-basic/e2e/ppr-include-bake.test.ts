import { test } from "@playwright/test";
import { runPprIncludeBakeTests } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";

// Issue #1179: a ppr page mounted through include() under a store layout
// whose client chrome reads the layout's ssr: false loader outside Suspense
// stores its shell, like the same page declared directly, on workerd with
// CFCacheStore. Fixture: src/pages/ppr-include-bake.tsx and the
// /ppr-include routes in src/urls.tsx (the layout sits in the root urls(),
// so router.routes() captures the include's parent). The body is shared with
// packages/rangojs-router/e2e/ppr-include-bake.test.ts.

function options(f: Fixture) {
  return {
    url: (pathname: string) => f.url(pathname),
    directPath: "/ppr-include/direct",
    includedPath: "/ppr-include/section/page",
  };
}

test.describe("ppr include bake (dev)", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runPprIncludeBakeTests(options(f));
});

test.describe("ppr include bake (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runPprIncludeBakeTests(options(f));
});
