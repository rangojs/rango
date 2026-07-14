import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

const SERVER_REQUEST_ID =
  /^req-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function defineDevelopmentSpec(f: Fixture, cachedPath: string): void {
  test("echoes a unique server-owned request ID", async ({ request }) => {
    const headers = { "X-RSC-Router-Request-Id": "browser-navigation-7" };
    const first = await request.get(f.url("/"), { headers });
    const second = await request.get(f.url("/"), { headers });

    const firstId = first.headers()["x-rango-request-id"];
    const secondId = second.headers()["x-rango-request-id"];
    expect(firstId).toMatch(SERVER_REQUEST_ID);
    expect(secondId).toMatch(SERVER_REQUEST_ID);
    expect(firstId).not.toBe("browser-navigation-7");
    expect(secondId).not.toBe(firstId);

    const cachedUrl = f.url(`${cachedPath}?request-diagnostics=1`);
    const cachedFirst = await request.get(cachedUrl, { headers });
    const cachedBody = await cachedFirst.json();
    const cachedFirstId = cachedFirst.headers()["x-rango-request-id"];
    expect(cachedFirstId).toMatch(SERVER_REQUEST_ID);
    let cacheHitId: string | undefined;
    await expect(async () => {
      const cacheHit = await request.get(cachedUrl, { headers });
      expect(await cacheHit.json()).toEqual(cachedBody);
      cacheHitId = cacheHit.headers()["x-rango-request-id"];
      expect(cacheHitId).toMatch(SERVER_REQUEST_ID);
      expect(cacheHitId).not.toBe(cachedFirstId);
      expect(cacheHitId).not.toBe("browser-navigation-7");
    }).toPass({ timeout: 5_000 });
    expect(cacheHitId).toBeDefined();
  });
}

function defineProductionSpec(f: Fixture, cachedPath: string): void {
  test("does not emit development request diagnostics", async ({ request }) => {
    const response = await request.get(f.url("/"), {
      headers: { "X-RSC-Router-Request-Id": "browser-navigation-7" },
    });
    expect(response.headers()["x-rango-request-id"]).toBeUndefined();

    const cachedUrl = f.url(`${cachedPath}?request-diagnostics=1`);
    const cachedFirst = await request.get(cachedUrl);
    const cachedBody = await cachedFirst.json();
    expect(cachedFirst.headers()["x-rango-request-id"]).toBeUndefined();
    await expect(async () => {
      const cacheHit = await request.get(cachedUrl);
      expect(await cacheHit.json()).toEqual(cachedBody);
      expect(cacheHit.headers()["x-rango-request-id"]).toBeUndefined();
    }).toPass({ timeout: 5_000 });
  });
}

test.describe("request diagnostics", () => {
  defineDevelopmentSpec(
    useFixture({ root: ".", mode: "dev" }),
    "/test/cached-json",
  );
});

test.describe("request diagnostics (production)", () => {
  defineProductionSpec(
    useFixture({ root: ".", mode: "build" }),
    "/test/cached-json",
  );
});
