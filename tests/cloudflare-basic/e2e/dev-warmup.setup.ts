import { test as setup, expect } from "@playwright/test";

// Serial: the ppr warmup below must run AFTER the base warmup has absorbed the
// dep-optimizer churn (fullyParallel would otherwise let them race on local
// 2-worker runs and the ppr GETs could see transient optimizer 500s).
setup.describe.configure({ mode: "serial" });

// Warm up the shared dev server before tests start.
// The first SSR request triggers Vite's dep optimizer to discover SSR deps
// (ERR_OUTDATED_OPTIMIZED_DEP). This takes a few seconds, after which a
// page reload picks up the new pre-bundle and hydration succeeds.
setup("warmup dev server", async ({ page, baseURL }) => {
  setup.setTimeout(60_000);

  // First request triggers SSR dep optimization
  await page.goto(baseURL!);

  // Wait for Vite to finish re-bundling SSR deps
  await expect(async () => {
    await page.reload();
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        return (
          el && Object.keys(el).some((key) => key.startsWith("__reactFiber"))
        );
      },
      "body",
      { timeout: 5_000 },
    );
  }).toPass({ timeout: 30_000, intervals: [2_000, 3_000, 5_000] });
});

// Every ppr-declared fixture route in src/urls.tsx. The plain GET compiles each
// route's page/loader modules through the dev transform pipeline; the background
// capture it schedules compiles the capture-only path (loader mask,
// captureShellHTML, the fizz prerender). `?probe=warmup` isolates the warmup's
// shell entries from every test key (the shell key includes the query), so no
// test-visible MISS/HIT sequence is perturbed — only the module graph is warmed.
const PPR_WARMUP_ROUTES = [
  "/ppr-shell",
  "/ppr-shell/stream",
  "/ppr-shell/no-hole",
  "/ppr-drift",
  "/ppr-blog",
  "/ppr-blog/getting-started-with-rsc",
];

// Capturable subset: polled to x-rango-shell HIT, which proves the FULL capture
// pipeline (Flight render, fizz prerender+abort, putShell) is hot, not merely
// requested. /ppr-shell/no-hole is excluded — it can never HIT (no loading()
// boundary; the ppr-shell suite pins that negative). /ppr-blog/:slug shares its
// modules with /ppr-blog, so polling the index covers it.
const PPR_WARMUP_HIT_ROUTES = [
  "/ppr-shell",
  "/ppr-shell/stream",
  "/ppr-drift",
  "/ppr-blog",
];

// Warm the PPR capture pipeline before the ppr-shell dev tests run.
//
// On a cold CI runner the dev module graph is compiled ON DEMAND during the
// capture render, repeatedly blowing the capture's 5s budget
// (SHELL_CAPTURE_MAX_WAIT_MS): one probe cycle is ~5s attempt + ~5s in-place
// retry + backoff, so warmToHit's 20s window fits only ~2 cycles and the suite
// hard-fails on runners that need more (#652 item 3 — the eternal-MISS shape
// survived the runtime-side dev backoff cap alone; see PR #659's first CI run,
// `physics hole` 3x at ~20s). Warming here makes the first real capture attempt
// run against a hot graph, so it completes inside its budget on attempt 1; the
// dev backoff cap stays as the safety net for anything this warmup missed.
setup("warmup ppr capture path", async ({ request }) => {
  setup.setTimeout(180_000);

  // Compile every ppr fixture route's modules (axis-1 render + scheduled
  // background capture per route).
  for (const route of PPR_WARMUP_ROUTES) {
    const res = await request.get(`${route}?probe=warmup`, {
      headers: { Accept: "text/html" },
    });
    expect(res.status()).toBe(200);
  }

  // Drive each capturable fixture to a stored shell. The first route pays the
  // shared cold-pipeline cost; the rest confirm their route-specific modules.
  // The dev backoff cap (~2s) guarantees the poll is never frozen out between
  // attempts.
  for (const route of PPR_WARMUP_HIT_ROUTES) {
    await expect(async () => {
      const res = await request.get(`${route}?probe=warmup`, {
        headers: { Accept: "text/html" },
      });
      expect(res.status()).toBe(200);
      expect(res.headers()["x-rango-shell"]).toBe("HIT");
    }).toPass({ timeout: 60_000 });
  }
});
