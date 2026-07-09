/**
 * Soft redirect guard e2e on Cloudflare (dev + production).
 * Document-native cases live in the router test-app redirect-guard suite;
 * this suite pins the partial/action channel (204 + X-RSC-Redirect).
 */
import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

const EVIL = "https://evil.example/phish";
const EXTERNAL = "https://accounts.example.com/oauth";

function softRedirectGuardTests(f: Fixture) {
  const goUrl = (to: string, ext = false) => {
    const params = new URLSearchParams({ to, _rsc_partial: "1" });
    if (ext) params.set("ext", "1");
    return f.url(`/redirect-guard/go?${params.toString()}`);
  };

  test("soft partial: same-origin becomes 204 + absolute X-RSC-Redirect", async ({
    request,
  }) => {
    const res = await request.get(goUrl("/about"), { maxRedirects: 0 });
    expect(res.status()).toBe(204);
    const soft = res.headers()["x-rsc-redirect"];
    expect(soft).toBeTruthy();
    expect(new URL(soft!).pathname).toBe("/about");
    expect(res.headers()["location"]).toBeUndefined();
  });

  test("soft partial: cross-origin without external is neutralized to /", async ({
    request,
  }) => {
    const res = await request.get(goUrl(EVIL), { maxRedirects: 0 });
    expect(res.status()).toBe(204);
    const soft = res.headers()["x-rsc-redirect"];
    expect(soft).toBeTruthy();
    expect(new URL(soft!).pathname).toBe("/");
  });

  test("soft partial: external opt-in keeps absolute off-host X-RSC-Redirect", async ({
    request,
  }) => {
    const res = await request.get(goUrl(EXTERNAL, true), { maxRedirects: 0 });
    expect(res.status()).toBe(204);
    expect(res.headers()["x-rsc-redirect"]).toBe(EXTERNAL);
    expect(res.headers()["x-rango-redirect-external"]).toBeUndefined();
  });
}

test.describe("soft redirect guard", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  softRedirectGuardTests(f);
});

test.describe("soft redirect guard (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  softRedirectGuardTests(f);
});
