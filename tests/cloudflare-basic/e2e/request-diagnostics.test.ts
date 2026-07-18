import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

const SERVER_REQUEST_ID =
  /^req-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function expectRequestTiming(
  headers: Record<string, string>,
  requestId: string,
): void {
  expect(headers["server-timing"]).toContain(
    `rango-request-id;desc="${requestId}"`,
  );
}

function expectNoRequestTiming(headers: Record<string, string>): void {
  expect(headers["server-timing"] ?? "").not.toContain("rango-request-id");
}

function defineDevelopmentSpec(
  f: Fixture,
  cachedPath: string,
  errorPath: string,
): void {
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
    expectRequestTiming(first.headers(), firstId!);
    expectRequestTiming(second.headers(), secondId!);

    const cachedUrl = f.url(`${cachedPath}?request-diagnostics=1`);
    const cachedFirst = await request.get(cachedUrl, { headers });
    const cachedBody = await cachedFirst.json();
    const cachedFirstId = cachedFirst.headers()["x-rango-request-id"];
    expect(cachedFirstId).toMatch(SERVER_REQUEST_ID);
    expectRequestTiming(cachedFirst.headers(), cachedFirstId!);
    let cacheHitId: string | undefined;
    await expect(async () => {
      const cacheHit = await request.get(cachedUrl, { headers });
      expect(await cacheHit.json()).toEqual(cachedBody);
      cacheHitId = cacheHit.headers()["x-rango-request-id"];
      expect(cacheHitId).toMatch(SERVER_REQUEST_ID);
      expect(cacheHitId).not.toBe(cachedFirstId);
      expect(cacheHitId).not.toBe("browser-navigation-7");
      expectRequestTiming(cacheHit.headers(), cacheHitId!);
    }).toPass({ timeout: 5_000 });
    expect(cacheHitId).toBeDefined();
  });

  test("echoes development request diagnostics on failed responses", async ({
    request,
  }) => {
    const response = await request.get(f.url(errorPath));
    const requestId = response.headers()["x-rango-request-id"];
    expect(response.status()).toBe(500);
    expect(requestId).toMatch(SERVER_REQUEST_ID);
    expectRequestTiming(response.headers(), requestId!);
  });
}

function defineProductionSpec(
  f: Fixture,
  cachedPath: string,
  errorPath: string,
): void {
  test("does not emit development request diagnostics", async ({ request }) => {
    const response = await request.get(f.url("/"), {
      headers: { "X-RSC-Router-Request-Id": "browser-navigation-7" },
    });
    expect(response.headers()["x-rango-request-id"]).toBeUndefined();
    expectNoRequestTiming(response.headers());

    const cachedUrl = f.url(`${cachedPath}?request-diagnostics=1`);
    const cachedFirst = await request.get(cachedUrl);
    const cachedBody = await cachedFirst.json();
    expect(cachedFirst.headers()["x-rango-request-id"]).toBeUndefined();
    expectNoRequestTiming(cachedFirst.headers());
    await expect(async () => {
      const cacheHit = await request.get(cachedUrl);
      expect(await cacheHit.json()).toEqual(cachedBody);
      expect(cacheHit.headers()["x-rango-request-id"]).toBeUndefined();
      expectNoRequestTiming(cacheHit.headers());
    }).toPass({ timeout: 5_000 });
  });

  test("does not emit development request diagnostics on failed responses", async ({
    request,
  }) => {
    const response = await request.get(f.url(errorPath));
    expect(response.status()).toBe(500);
    expect(response.headers()["x-rango-request-id"]).toBeUndefined();
    expectNoRequestTiming(response.headers());
  });
}

test.describe("request diagnostics", () => {
  defineDevelopmentSpec(
    useFixture({ root: ".", mode: "dev" }),
    "/test/cached-json",
    "/__test/last-error?status-500=1",
  );
});

test.describe("request diagnostics (production)", () => {
  defineProductionSpec(
    useFixture({ root: ".", mode: "build" }),
    "/test/cached-json",
    "/__test/last-error?status-500=1",
  );
});
