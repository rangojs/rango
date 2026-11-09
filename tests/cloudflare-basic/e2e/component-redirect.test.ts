import { test } from "@playwright/test";
import { useFixture } from "./fixture";
import { defineComponentRedirectTests } from "@shared/e2e";

// On workerd: an async server component that throws redirect() after its
// handler returned sends the visitor to the target, not to the error page.
// Fixture: src/pages/component-redirect.tsx.

test.describe("component redirect", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  defineComponentRedirectTests(() => ({ url: (p) => f.url(p) }));
});

test.describe("component redirect (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  defineComponentRedirectTests(() => ({ url: (p) => f.url(p) }));
});
