import { test } from "@playwright/test";
import { useFixture } from "./fixture";
import { defineComponentRedirectTests } from "@shared/e2e";

// An async server component that throws redirect() after its handler
// returned sends the visitor to the target, not to the error page. Fixture:
// test-app/src/urls/component-redirect.tsx.

test.describe("component redirect", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "dev" });
  defineComponentRedirectTests(() => ({ url: (p) => f.url(p) }));
});

test.describe("component redirect (production)", () => {
  const f = useFixture({ root: "./e2e/test-app", mode: "build" });
  defineComponentRedirectTests(() => ({ url: (p) => f.url(p) }));
});
