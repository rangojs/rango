import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

/**
 * The raw request-identity reads (#976) on workerd (cloudflare-basic)
 * (src/pages/identity-raw.tsx): `ctx.request.headers` and
 * `getRequestContext().cookie()` / `.cookies()` refuse where `cookies()`
 * does, a key() reads the header freely, and copies of `ctx.request` keep
 * working inside a cache() boundary.
 *
 * Each test owns its entries through a unique probe (the servers outlive a
 * test).
 */

const visitor = (name: string) => ({
  Accept: "text/html",
  "x-visitor": name,
  Cookie: `visitor=${name}`,
});

function uniqueProbe(): string {
  return `raw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function runIdentityRawSpec(f: Fixture, production: boolean): void {
  test("a ppr route reading ctx.request.headers never serves a HIT with another visitor's value", async ({
    request,
  }) => {
    const probe = uniqueProbe();
    // The control reads nothing: it warms to a HIT, so the MISSes below are
    // refusals, not a cold capture pipeline.
    await expect(async () => {
      const res = await request.get(
        f.url(`/identity-raw/ppr-control?probe=${probe}`),
        { headers: visitor("a") },
      );
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
    }).toPass({ timeout: 20000 });

    const url = f.url(`/identity-raw/ppr?probe=${probe}`);
    for (const name of ["a", "a", "b", "a", "b", "b"]) {
      const res = await request.get(url, { headers: visitor(name) });
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rango-shell"]).toBe("MISS");
      const html = await res.text();
      expect(html).toContain(`ppr-visitor-is-${name}`);
      expect(html).not.toContain(`ppr-visitor-is-${name === "a" ? "b" : "a"}`);
      // Room for the MISS's background capture to land, were it stored.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  });

  for (const [read, surface, verb] of [
    ["headers", "ctx.request.headers", "read"],
    ["cookie", "getRequestContext().cookie()", "called"],
    ["cookies", "getRequestContext().cookies()", "called"],
  ] as const) {
    test(`${surface} in a cache() handler renders the error boundary for every visitor`, async ({
      request,
    }) => {
      const url = f.url(
        `/identity-raw/cached?read=${read}&probe=${uniqueProbe()}`,
      );
      for (const name of ["a", "b"]) {
        const res = await request.get(url, { headers: visitor(name) });
        const html = await res.text();
        expect(html).toContain('data-testid="identity-raw-error"');
        expect(html).not.toContain("cached-visitor-is-");
        if (!production) {
          expect(html).toContain(
            `${surface} cannot be ${verb} inside a cache() boundary`,
          );
        }
      }
    });
  }

  test('ctx.request.headers in a "use cache" body renders the error boundary; a header passed in keys the entry', async ({
    request,
  }) => {
    for (const name of ["a", "b"]) {
      const res = await request.get(f.url("/identity-raw/use-cache"), {
        headers: visitor(name),
      });
      const html = await res.text();
      expect(html).toContain('data-testid="identity-raw-error"');
      expect(html).not.toContain("uc-visitor-is-");
      if (!production) {
        expect(html).toContain("&quot;use cache&quot; function");
      }
    }

    const url = f.url(`/identity-raw/use-cache-arg?probe=${uniqueProbe()}`);
    const valueFor = async (name: string) => {
      const res = await request.get(url, { headers: visitor(name) });
      const match = /uc-arg-visitor-is-([^<]+)</.exec(await res.text());
      return match?.[1];
    };
    const a = await valueFor("a");
    expect(a).toMatch(/^a:/);
    expect(await valueFor("a")).toBe(a);
    const b = await valueFor("b");
    expect(b).toMatch(/^b:/);
    expect(b).not.toBe(a);
  });

  test("a cache() key() reads ctx.request.headers and partitions the record", async ({
    request,
  }) => {
    const url = f.url(`/identity-raw/keyed?probe=${uniqueProbe()}`);
    const stampFor = async (name: string) => {
      const res = await request.get(url, { headers: visitor(name) });
      expect(res.status()).toBe(200);
      return /stamp-([\w-]+)/.exec(await res.text())?.[1];
    };
    const a = await stampFor("a");
    expect(a).toBeDefined();
    expect(await stampFor("a")).toBe(a);
    const b = await stampFor("b");
    expect(b).toBeDefined();
    expect(b).not.toBe(a);
  });

  test("fetch(ctx.request), new Request(ctx.request) and ctx.request.clone() work inside a cache() boundary", async ({
    request,
  }) => {
    const res = await request.get(
      f.url(`/identity-raw/copies?nonce=${uniqueProbe()}`),
      { headers: visitor("a") },
    );
    expect(res.status()).toBe(200);
    // workerd copies the headers natively: none of the three reads them
    // through the guard, and the forwarded request carries the visitor's.
    expect(await res.text()).toContain("copy:GET clone:true fetch:echo-a");
  });
}

test.describe("identity raw reads", () => {
  const f = useFixture({ root: ".", mode: "dev" });
  runIdentityRawSpec(f, false);
});

test.describe("identity raw reads (production)", () => {
  const f = useFixture({ root: ".", mode: "build" });
  runIdentityRawSpec(f, true);
});
