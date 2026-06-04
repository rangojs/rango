import { expect } from "@playwright/test";

const HYDRATION_ERROR_MARKERS = [
  "Hydration failed",
  "hydration mismatch",
  "Text content does not match",
  "did not match",
  "server rendered HTML",
  "Hydration error",
];

function isHydrationError(text) {
  return HYDRATION_ERROR_MARKERS.some((marker) => text.includes(marker));
}

// Wait for React hydration to complete (the rango client runtime sets
// data-hydrated on <html>) and assert no hydration errors were logged.
export async function waitForHydration(page) {
  const hydrationErrors = [];

  const consoleHandler = (msg) => {
    const text = msg.text();
    if (isHydrationError(text)) hydrationErrors.push(text);
  };
  const pageErrorHandler = (error) => {
    if (isHydrationError(error.message)) hydrationErrors.push(error.message);
  };

  page.on("console", consoleHandler);
  page.on("pageerror", pageErrorHandler);

  try {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => document.documentElement.hasAttribute("data-hydrated"),
      { timeout: 20000 },
    );
    await page.waitForTimeout(100);
    if (hydrationErrors.length > 0) {
      throw new Error(
        `Hydration errors detected:\n${hydrationErrors.join("\n")}`,
      );
    }
  } finally {
    page.off("console", consoleHandler);
    page.off("pageerror", pageErrorHandler);
  }
}

// Collect page errors and assert none occurred at scope exit (using-disposable).
export function expectNoPageError(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  return {
    [Symbol.dispose]: () => {
      expect(errors).toEqual([]);
    },
  };
}

// Parse the first (optionally negative) integer out of an element's text.
export function parseNumber(text) {
  return parseInt(text?.match(/-?\d+/)?.[0] || "0", 10);
}

// Poll an HTTP endpoint until the server is actually serving, not merely
// listening. Vite prints its URL before the first SSR request triggers the dep
// optimizer (which re-evaluates modules), so a request that lands in that
// window gets net::ERR_EMPTY_RESPONSE and only passes on retry (green-but-flaky).
// Requiring `settleOks` consecutive OK responses absorbs that cycle. On timeout
// the captured stdout/stderr is included so the real failure is visible.
export async function waitForServer(
  url,
  { getOutput, settleOks = 1, timeoutMs = process.env.CI ? 60000 : 30000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { accept: "text/html" } });
      if (res.ok) {
        await res.text(); // drain the body so the SSR/RSC pipeline completes
        if (++consecutive >= settleOks) return;
      } else {
        consecutive = 0;
      }
    } catch {
      consecutive = 0;
    }
    await new Promise((r) => setTimeout(r, consecutive > 0 ? 250 : 100));
  }
  const out = getOutput?.();
  const tail = (s) => (s || "").slice(-2000);
  const details = out
    ? `\n--- stdout ---\n${tail(out.stdout)}\n--- stderr ---\n${tail(out.stderr)}`
    : "";
  throw new Error(`Server not ready after ${timeoutMs}ms: ${url}${details}`);
}
