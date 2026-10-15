import { test } from "@playwright/test";
import { runPprIncludeBakeTests } from "@shared/e2e";
import { useFixture, type Fixture } from "./fixture";

// Issue #1179: a ppr page mounted through include() under a store layout
// whose client chrome reads the layout's ssr: false loader outside Suspense
// stores its shell, like the same page declared directly. Fixture:
// test-app/src/urls/ppr-include-bake.tsx (mounted through include("/"), so
// the inner include captures its parent on the runtime expansion). The body
// is shared with tests/cloudflare-basic/e2e/ppr-include-bake.test.ts, where
// the layout sits in the root urls(). The capture's lanes are pinned through
// serveShellRequest in
// src/testing/__tests__/serve-shell-request-include-bake.rsc-test.tsx.

function options(f: Fixture) {
  return {
    url: (pathname: string) => f.url(pathname),
    directPath: "/ppr-include/direct",
    includedPath: "/ppr-include/section/page",
  };
}

test.describe("ppr include bake (dev)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  runPprIncludeBakeTests(options(f));
});

test.describe("ppr include bake (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  runPprIncludeBakeTests(options(f));
});
