import { test } from "@playwright/test";
import { defineSlotRedirectTests } from "@shared/e2e";
import { useFixture } from "./fixture";

// redirect() from a parallel() slot handler: a 302 on a document request and on
// a Link click, and a render-failed on-demand refresh that keeps the stored
// page. The bodies and the fixture contract live in @shared/e2e
// (slot-redirect-scenario), shared with the router's own e2e app.
test.describe("parallel slot redirect", () => {
  defineSlotRedirectTests(useFixture({ root: ".", mode: "dev" }));
});

test.describe("parallel slot redirect (production)", () => {
  defineSlotRedirectTests(useFixture({ root: ".", mode: "build" }));
});
