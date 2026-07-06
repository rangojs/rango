import { expect, test } from "@playwright/test";
import { useFixture, type Fixture } from "./fixture";

// PPR capture-budget + nameless-route coverage (issues #714 / #715), backed by
// the fixtures in test-app/src/urls/shell-cache.tsx:
//
// - /shell-cache/nameless/:probe — a NAMELESS ppr route (#714). `name` is
//   orthogonal to shell caching: the DSL registers the entry under a
//   synthesized $path_* manifest key with the ppr option intact, so the route
//   must engage (MISS -> HIT) exactly like a named one.
// - /shell-cache/slow-meta — deferred shell material settling IN PARTS
//   (immediate push, ~5.5s slow push, Meta title CHAINED off the slow promise
//   +1s ≈ 6.5s total) with `ppr.captureTimeout: 10000` (#715). The capture
//   awaits the COMPLETE settlement sequence (the gate holds while top-level
//   pushes are pending; SsrRoot suspends at the root until the final snapshot)
//   and bakes the resolved values into the stored prelude.
// - /shell-cache/slow-meta-default — the SAME material with NO captureTimeout:
//   the default 5s budget expires with pushes pending and the capture REFUSES
//   (eternal MISS + the once-per-key no-usable-shell warning). A partial-meta
//   shell is never stored.
//
// Own file (not shell-cache.test.ts): the slow fixtures cost real wall-clock
// per request (the live render also awaits the pushes), so they get their own
// isolatedServer lifecycle and stay out of the main suite's timing.

const HTML_HEADERS = { Accept: "text/html" };

// Parts settle at ~5.5s (slow) and ~6.5s (chained Meta); the capture then
// needs quiesce + fizz + store. A generous ceiling absorbs CI-runner noise.
const HIT_POLL_TIMEOUT_MS = 45_000;
// Two default-budget capture attempts (5s + 400ms retry + 5s) plus margin —
// the window in which the no-knob route's capture deterministically refuses.
const DEFAULT_BUDGET_REFUSAL_MS = 12_000;

/**
 * Fetch a document and split it at the frozen-prelude boundary (the stored
 * prelude ends at </html>; everything after is the resumed tail). Returns the
 * shell status header alongside so callers assert composition and status off
 * ONE request.
 */
async function fetchSplit(url: string): Promise<{
  status: string | undefined;
  prelude: string;
  resumed: string;
  html: string;
}> {
  const res = await fetch(url, { headers: HTML_HEADERS });
  expect(res.status).toBe(200);
  const html = await res.text();
  const preludeEnd = html.indexOf("</html>");
  expect(preludeEnd).toBeGreaterThan(-1);
  return {
    status: res.headers.get("x-rango-shell") ?? undefined,
    prelude: html.slice(0, preludeEnd),
    resumed: html.slice(preludeEnd),
    html,
  };
}

function runSpec(f: Fixture): void {
  test("nameless ppr route engages: MISS then HIT (issue #714)", async ({
    request,
  }) => {
    const url = f.url("/shell-cache/nameless/e2e?probe=nameless714");
    const first = await request.get(url, { headers: HTML_HEADERS });
    expect(first.status()).toBe(200);
    expect(first.headers()["x-rango-shell"]).toBe("MISS");
    const html = await first.text();
    expect(html).toContain("Live price:");

    await expect(async () => {
      const res = await request.get(url, { headers: HTML_HEADERS });
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
    }).toPass({ timeout: 15_000 });

    // The HIT composes: frozen prelude + live resumed hole.
    const hit = await fetchSplit(url);
    expect(hit.status).toBe("HIT");
    expect(hit.resumed).toContain("Live price:");
  });

  test("captureTimeout admits staged deferred material: MISS -> HIT with ALL parts baked in the stored prelude (issue #715)", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const url = f.url("/shell-cache/slow-meta?probe=ct715");
    // The live render itself awaits the pushes (~6.5s), so raise per-call
    // ceilings accordingly.
    const first = await request.get(url, {
      headers: HTML_HEADERS,
      timeout: 30_000,
    });
    expect(first.status()).toBe(200);
    expect(first.headers()["x-rango-shell"]).toBe("MISS");
    // The MISS is a plain axis-1 render whose full-render handle barrier
    // awaits the staged pushes, so its body already proves the parts settle
    // on the LIVE path independent of any capture.
    const firstHtml = await first.text();
    expect(firstHtml).toMatch(/slow-meta-immediate-\d+/);
    expect(firstHtml).toMatch(/slow-meta-slow-\d+-chained/);

    await expect(async () => {
      const res = await request.get(url, {
        headers: HTML_HEADERS,
        timeout: 30_000,
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
    }).toPass({ timeout: HIT_POLL_TIMEOUT_MS, intervals: [2_000] });

    // STORED-prelude assertion: every part of the settlement sequence — the
    // immediate push, the slow push, and the Meta title CHAINED off the slow
    // value — is baked RESOLVED into the frozen prelude, all from the SAME
    // capture render (one seq). A partial prefix (immediate baked, chained
    // missing) must be unrepresentable.
    const hit = await fetchSplit(url);
    expect(hit.status).toBe("HIT");
    const seqMatch = hit.prelude.match(/slow-meta-immediate-(\d+)/);
    expect(seqMatch).not.toBeNull();
    const seq = seqMatch![1];
    expect(hit.prelude).toContain(`slow-meta-immediate-${seq}`);
    expect(hit.prelude).toContain(`slow-meta-slow-${seq}`);
    expect(hit.prelude).toContain(`slow-meta-slow-${seq}-chained`);
    // The chained value is the document TITLE (head material via the Meta
    // handle), not just body text.
    expect(hit.prelude).toMatch(
      new RegExp(`<title[^>]*>[^<]*slow-meta-slow-${seq}-chained`),
    );

    // Frozen across consecutive HITs: the prelude replays the SAME capture
    // seq (handlers re-run for the live tail, but the stored bytes are fixed).
    const second = await fetchSplit(url);
    expect(second.status).toBe("HIT");
    expect(second.prelude).toContain(`slow-meta-immediate-${seq}`);
    expect(second.prelude).toContain(`slow-meta-slow-${seq}-chained`);
  });

  test("same material WITHOUT captureTimeout refuses: stays MISS, no partial bake, once-per-key warning (issue #715 negative)", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const url = f.url("/shell-cache/slow-meta-default?probe=ct715neg");
    const first = await request.get(url, {
      headers: HTML_HEADERS,
      timeout: 30_000,
    });
    expect(first.status()).toBe(200);
    expect(first.headers()["x-rango-shell"]).toBe("MISS");

    // Wait past two full default-budget attempts (5s + retry + 5s), then
    // re-probe: still MISS — the capture refused rather than storing a shell
    // with unsettled meta. Two probes to also cover a backoff-window re-probe.
    await new Promise((r) => setTimeout(r, DEFAULT_BUDGET_REFUSAL_MS));
    for (let i = 0; i < 2; i++) {
      const res = await request.get(url, {
        headers: HTML_HEADERS,
        timeout: 30_000,
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rango-shell"]).toBe("MISS");
    }

    // The once-per-key no-usable-shell warning names the refusal in the
    // server log (isolatedServer exposes the process streams).
    const logs = f.proc().stdout() + f.proc().stderr();
    expect(logs).toMatch(
      /Shell capture for "[^"]*slow-meta-default[^"]*" produced no usable shell after an in-place retry/,
    );
  });
}

test.describe("shell-capture-timeout (dev)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "dev",
    isolatedServer: true,
  });
  runSpec(f);
});

test.describe("shell-capture-timeout (production)", () => {
  const f = useFixture({
    root: "./e2e/test-app",
    mode: "build",
    isolatedServer: true,
  });
  runSpec(f);
});
