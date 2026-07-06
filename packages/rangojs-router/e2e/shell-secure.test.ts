import { expect, test, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// PPR guarding + scope fidelity (docs/design/ppr-shell-resume.md). The PPR
// commit point is AFTER the whole middleware chain — global router.use() AND
// route DSL middleware() both wrap the render pass — so a middleware rejection
// wins before a single shell byte, on MISS and on a warmed HIT alike. Fixtures:
//   /shell-secure      — GLOBAL auth middleware (router.tsx), 401 without the
//                        x-shell-auth header, ctx.set("shellMwVar") when authed;
//   /shell-secure-dsl  — the SAME rejection as ROUTE DSL middleware() in urls();
//   /shell-secure-runs — middleware-run counter, OUTSIDE the auth mount.
// Scope fidelity: the background capture inherits the request's post-middleware
// context, so the captured prelude carries the middleware-derived value while
// middleware itself NEVER re-runs during capture (the run counter advances by
// exactly one per HTTP request, captures included).

const AUTH_HEADERS = { Accept: "text/html", "x-shell-auth": "yes" };
const NO_AUTH_HEADERS = { Accept: "text/html" };

async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: AUTH_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 10000 });
}

function runShellSecureSpec(f: Fixture): void {
  test("unauthorized request to a WARMED shell route gets its 401 with zero shell bytes (global middleware)", async ({
    request,
  }) => {
    const url = f.url("/shell-secure?probe=sec-global");
    await warmToHit(request, url);

    const res = await request.get(url, { headers: NO_AUTH_HEADERS });
    expect(res.status()).toBe(401);
    const body = await res.text();
    // The middleware short-circuit returned before the commit point: no shell
    // markup, no shell status header.
    expect(body).toBe("unauthorized");
    expect(body).not.toContain("Shell Secure Demo");
    expect(res.headers()["x-rango-shell"]).toBeUndefined();
  });

  test("unauthorized request rejected by ROUTE DSL middleware gets its 401 with zero shell bytes", async ({
    request,
  }) => {
    const url = f.url("/shell-secure-dsl?probe=sec-dsl");
    await warmToHit(request, url);

    const res = await request.get(url, { headers: NO_AUTH_HEADERS });
    expect(res.status()).toBe(401);
    const body = await res.text();
    expect(body).toBe("unauthorized-dsl");
    expect(body).not.toContain("Shell Secure Demo");
    expect(res.headers()["x-rango-shell"]).toBeUndefined();
  });

  test("scope fidelity: the warmed shell prelude carries the middleware-derived ctx value", async ({
    request,
  }) => {
    const url = f.url("/shell-secure?probe=sec-scope");
    await warmToHit(request, url);

    const res = await request.get(url, { headers: AUTH_HEADERS });
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
    const html = await res.text();
    const prelude = html.slice(0, html.indexOf("</html>"));
    // The auth middleware set shellMwVar on the triggering request; the capture
    // inherited that post-middleware state and photographed it into the shell.
    expect(prelude).toContain("MW-SCOPE-VALUE");
  });

  test("capture never re-runs middleware: the run counter advances exactly once per HTTP request", async ({
    request,
  }) => {
    const url = f.url("/shell-secure?probe=sec-count");
    await warmToHit(request, url);

    const readRuns = async () =>
      Number(await (await request.get(f.url("/shell-secure-runs"))).text());

    const before = await readRuns();
    const N = 4;
    for (let i = 0; i < N; i++) {
      const res = await request.get(url, { headers: AUTH_HEADERS });
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
    }
    // Give any (unexpected) background capture time to run before sampling.
    await new Promise((r) => setTimeout(r, 300));
    const after = await readRuns();
    // Exactly one middleware run per request — background captures (warm-up and
    // any SWR recapture) inherit the request's post-middleware context instead
    // of re-running the chain.
    expect(after - before).toBe(N);
  });
}

test.describe("shell-secure (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runShellSecureSpec(f);
});

test.describe("shell-secure (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runShellSecureSpec(f);
});
