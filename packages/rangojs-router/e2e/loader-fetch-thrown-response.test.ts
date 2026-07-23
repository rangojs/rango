/**
 * E2E: fetchable-loader thrown-Response + production error-name leak.
 *
 * D4 — a fetchable loader with NO middleware that `throw redirect(...)` must
 * yield the real 302 (+ Location) through the _rsc_loader endpoint, not a
 * generic 500. (The with-middleware path already converted a thrown Response;
 * the no-middleware path reached the catch and 500'd before the fix.)
 *
 * D5 — in production the served error payload must NOT carry the consumer's
 * error class name (`err.name`); the client only reads `message`. In dev the
 * name is still present (developer-facing). Asserted by probing the RSC body
 * served from the endpoint for a recognizable sentinel class name.
 *
 * Both run over raw HTTP against the _rsc_loader endpoint in dev and the
 * bundled production build (loader IDs are hashed at build time, so the prod
 * suite discovers them via the /__test/loader-ids helper, mirroring
 * loader-fetchable-guard.test.ts and origin-guard.test.ts).
 */
import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

const SENTINEL_NAME = "RangoLeakSentinelError";

// ---------------------------------------------------------------------------
// Dev — direct HTTP with dev-style loader IDs
// ---------------------------------------------------------------------------
test.describe("loader-fetch thrown response", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });

  test.setTimeout(30000);

  test("D4: a thrown redirect Response yields a 302, not a 500", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/fetch-loader?_rsc_loader=src/loaders.tsx%23ThrownRedirectLoader"),
      {
        headers: { Accept: "text/x-component" },
        // Observe the redirect itself instead of following it (the target
        // route does not exist — it only proves the status/Location surfaced).
        maxRedirects: 0,
      },
    );

    expect([301, 302, 303, 307, 308]).toContain(response.status());
    expect(response.headers()["location"]).toBe("/redirected-loader-target");
  });

  test("D5 (dev): the error payload carries the consumer error class name", async ({
    request,
  }) => {
    const response = await request.get(
      f.url("/fetch-loader?_rsc_loader=src/loaders.tsx%23NamedErrorLoader"),
      { headers: { Accept: "text/x-component" } },
    );

    expect(response.status()).toBe(500);
    const body = await response.text();
    // Dev keeps err.name for developer diagnostics.
    expect(body).toContain(SENTINEL_NAME);
  });
});

// ---------------------------------------------------------------------------
// Production — direct HTTP with runtime-discovered hashed IDs
// ---------------------------------------------------------------------------
test.describe("loader-fetch thrown response (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
  });

  let loaderIds: { thrownRedirect: string; namedError: string };

  test.beforeAll(async ({ request }) => {
    const res = await request.get(f.url("/__test/loader-ids"), {
      headers: { Accept: "application/json" },
    });
    expect(res.status()).toBe(200);
    loaderIds = await res.json();
  });

  test("D4: a thrown redirect Response yields a 302, not a 500", async ({
    request,
  }) => {
    const response = await request.get(
      f.url(
        `/fetch-loader?_rsc_loader=${encodeURIComponent(loaderIds.thrownRedirect)}`,
      ),
      { headers: { Accept: "text/x-component" }, maxRedirects: 0 },
    );

    expect([301, 302, 303, 307, 308]).toContain(response.status());
    expect(response.headers()["location"]).toBe("/redirected-loader-target");
  });

  test("D5 (production): the error payload does NOT leak the consumer error class name", async ({
    request,
  }) => {
    const response = await request.get(
      f.url(
        `/fetch-loader?_rsc_loader=${encodeURIComponent(loaderIds.namedError)}`,
      ),
      { headers: { Accept: "text/x-component" } },
    );

    expect(response.status()).toBe(500);
    const body = await response.text();
    // Production gates err.name — the sentinel class name must be absent; only
    // the generic "Error" name and the sanitized message reach the client.
    expect(body).not.toContain(SENTINEL_NAME);
  });
});
