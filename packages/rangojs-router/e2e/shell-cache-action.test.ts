import { expect, test, type Page } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";
import { waitForHydration, expectNoPageError, testId } from "./helper";

// Deliverable 10: action correctness on PPR routes. The /shell-cache-action subtree
// (test-app/src/urls/shell-cache-action.tsx) is a PPR route whose SHELL carries a
// cached+tagged banner (frozen into the prelude) and whose HOLE is a live loader.
//   (a) a JS action mutating HOLE data (loader-fed) — the client applies the
//       result, and a later hard GET stays HIT with the mutated hole (loaders are
//       live under PPR, no invalidation needed);
//   (b) a JS action mutating SHELL material + updateTag() — a hard GET MISSes (the
//       tag cascade dropped the shell), then recaptures with the new shell content
//       in the prelude;
//   (c) progressive enhancement: a no-JS form POST renders via axis 1, with no HIT
//       composition on the POST response;
//   (d) the DSL-attached route (/shell-cache-dsl): a POST action bypasses the shell
//       middleware (non-GET) — the action response is untouched.
// Every test guards against hydration/console errors. Runs dev + production.

const HTML_HEADERS = { Accept: "text/html" };

/** Extract the integer from a "Count: 3 (seq 5)" string. */
function firstInt(text: string): number {
  const m = text.match(/-?\d+/);
  return m ? Number(m[0]) : NaN;
}

async function warmToHit(request: Page["request"], url: string): Promise<void> {
  await expect(async () => {
    const res = await request.get(url, { headers: HTML_HEADERS });
    expect(res.status()).toBe(200);
    expect(res.headers()["x-rango-shell"]).toBe("HIT");
  }).toPass({ timeout: 10000 });
}

function guardConsoleErrors(page: Page) {
  const errors: string[] = [];
  const bad = (t: string) =>
    t.includes("hydration") ||
    t.includes("Hydration") ||
    t.includes("Minified React error");
  const onConsole = (msg: import("@playwright/test").ConsoleMessage) => {
    if (msg.type() === "error" && bad(msg.text())) errors.push(msg.text());
  };
  const onPageError = (err: Error) => {
    if (bad(err.message)) errors.push(err.message);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  return {
    [Symbol.dispose]: () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      expect(errors, "no hydration / Minified React errors").toEqual([]);
    },
  };
}

// --- JS-enabled action spec (10a, 10b, 10d) ---
function runActionSpec(f: Fixture): void {
  // 10(a): a JS action mutating HOLE (loader-fed) data.
  test("JS action mutates the HOLE; a later hard GET stays HIT with the mutated value", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardConsoleErrors(page);

    const url = f.url("/shell-cache-action?probe=hole-a");
    await warmToHit(page.request, url);

    await page.goto(url);
    await waitForHydration(page);

    const before = firstInt(
      await testId(page, "shell-action-count").innerText(),
    );

    // Invoke the action (mutates the loader-fed module counter).
    await testId(page, "shell-action-increment").click();
    await expect(testId(page, "shell-action-result")).toContainText("applied:");
    const applied = firstInt(
      await testId(page, "shell-action-result").innerText(),
    );
    expect(applied).toBeGreaterThan(before);

    // The served page is still a HIT (the frozen shell is untouched)...
    const res = await page.request.get(url, { headers: HTML_HEADERS });
    expect(res.headers()["x-rango-shell"]).toBe("HIT");

    // ...and the live hole reflects the mutation on the next render (loaders run
    // fresh even on a HIT — only the HTML shell came from cache).
    await page.goto(url);
    await waitForHydration(page);
    const after = firstInt(
      await testId(page, "shell-action-count").innerText(),
    );
    expect(after).toBeGreaterThanOrEqual(applied);
  });

  // 10(b): a JS action mutating SHELL material + updateTag().
  test("JS action mutates SHELL material + updateTag: hard GET MISSes then recaptures the new shell", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardConsoleErrors(page);

    const url = f.url("/shell-cache-action?probe=shell-b");
    await warmToHit(page.request, url);

    await page.goto(url);
    await waitForHydration(page);

    // Mutate the cached+tagged shell banner and invalidate its tag.
    await testId(page, "shell-action-banner-btn").click();
    await expect(testId(page, "shell-action-banner-result")).toContainText(
      "updated: Banner v",
    );
    const newBanner = (
      await testId(page, "shell-action-banner-result").innerText()
    ).replace("updated: ", "");

    // The shell auto-carried the banner tag, so updateTag dropped it: the next hard
    // GET MISSes.
    const missRes = await page.request.get(url, { headers: HTML_HEADERS });
    expect(missRes.headers()["x-rango-shell"]).toBe("MISS");

    // A background recapture stores the NEW shell; poll to HIT and assert the new
    // banner is frozen into the prelude (before </html>).
    await warmToHit(page.request, url);
    const hit = await page.request.get(url, { headers: HTML_HEADERS });
    const html = await hit.text();
    const prelude = html.slice(0, html.indexOf("</html>"));
    expect(prelude).toContain(newBanner);
  });

  // 10(d): the DSL-attached route — a POST action bypasses the shell middleware.
  test("DSL route: a POST action bypasses shell logic (no HIT composition on the action response)", async ({
    page,
  }) => {
    using _ = expectNoPageError(page);
    using __ = guardConsoleErrors(page);

    const url = f.url("/shell-cache-dsl?probe=dsl-d");
    // Warm the DSL route to HIT so the GET path is composing shells...
    await warmToHit(page.request, url);

    await page.goto(url);
    await waitForHydration(page);

    // Capture the action POST response (an _rsc_action fetch) to assert the
    // middleware did NOT compose a shell onto it (non-GET bypass).
    const actionResponse = page.waitForResponse(
      (r) =>
        r.url().includes("/shell-cache-dsl") && r.request().method() === "POST",
    );
    await testId(page, "shell-dsl-action-btn").click();
    const res = await actionResponse;

    // The action ran and the client applied the result...
    await expect(testId(page, "shell-dsl-action-result")).toContainText(
      "applied:",
    );
    // ...and the action response was untouched by the shell middleware.
    expect(res.headers()["x-rango-shell"]).toBeUndefined();
  });
}

// --- Progressive enhancement spec (10c) — JS disabled ---
function runPeSpec(f: Fixture): void {
  test("no-JS PE form POST renders via axis 1 (shell-visible result), no HIT composition on the POST", async ({
    page,
  }) => {
    // First GET is a MISS served via axis 1 (no-JS). The PE form + result live in
    // the SHELL (dedicated /shell-cache-action/pe route), so they render without JS
    // (no hidden Suspense template).
    const url = f.url("/shell-cache-action/pe?probe=pe-c");
    await page.goto(url);
    await expect(testId(page, "shell-action-pe-result")).toHaveText("none");

    // Capture the native form POST response to assert no HIT composition.
    const postResponse = page.waitForResponse(
      (r) =>
        r.url().includes("/shell-cache-action") &&
        r.request().method() === "POST",
    );
    await testId(page, "shell-action-pe-submit").click();
    const res = await postResponse;

    // The POST is non-GET, so the shell middleware bypassed to axis 1: no HIT
    // composition (and, being GET-gated, it scheduled no capture).
    expect(["MISS", undefined]).toContain(res.headers()["x-rango-shell"]);

    // Axis 1 re-rendered correctly (formState): the SHELL-visible marker reflects
    // the submission.
    await page.waitForLoadState("domcontentloaded");
    await expect(testId(page, "shell-action-pe-result")).toHaveText(/^pe-\d+$/);
  });
}

test.describe("shell-cache action correctness (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runActionSpec(f);
});

test.describe("shell-cache action correctness (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runActionSpec(f);
});

test.describe("shell-cache PE action (dev)", () => {
  test.use({ javaScriptEnabled: false });
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runPeSpec(f);
});

test.describe("shell-cache PE action (production)", () => {
  test.use({ javaScriptEnabled: false });
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runPeSpec(f);
});
