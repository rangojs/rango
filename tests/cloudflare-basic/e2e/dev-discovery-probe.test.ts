import { expect, test } from "@playwright/test";
import { useFixture } from "./fixture";

/**
 * Dev-discovery probe short-circuit.
 *
 * The readiness loop in src/vite/router-discovery.ts probes the dev server
 * with DEV_DISCOVERY_PROBE_HEADER after a workerd reload. Every router
 * generation — current or stale — must answer a probe with an empty body and
 * its actual epoch. A stale generation that instead fell through to a full
 * app render (the pre-fix behavior) overlapped renders with workerd reloads
 * on every 25 ms probe and could exhaust the dev server heap.
 *
 * The header names are hardcoded to pin the wire contract
 * (src/dev-discovery-protocol.ts); renaming them must break this test.
 * Epochs are Date.now()-based (vite/discovery/state.ts), so a probe of "1"
 * can never match a live epoch — the dev assertion always exercises the
 * mismatched-epoch path.
 */
const PROBE_HEADER = "x-rango-dev-discovery-probe";
const EPOCH_HEADER = "x-rango-dev-discovery-epoch";

test.describe("dev-discovery probe short-circuit (dev)", () => {
  const f = useFixture({
    root: ".",
    mode: "dev",
  });

  test("a mismatched-epoch probe answers empty with the actual epoch instead of rendering", async ({
    request,
  }) => {
    const response = await request.get(f.url("./"), {
      headers: { [PROBE_HEADER]: "1" },
    });
    expect(response.status()).toBe(200);
    expect(Number(response.headers()[EPOCH_HEADER])).toBeGreaterThan(1);
    expect(await response.text()).toBe("");
  });
});

test.describe("dev-discovery probe short-circuit (production)", () => {
  const f = useFixture({
    root: ".",
    mode: "build",
  });

  test("the probe header is inert in a built worker and the page renders", async ({
    request,
  }) => {
    const response = await request.get(f.url("./"), {
      headers: { [PROBE_HEADER]: "1" },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()[EPOCH_HEADER]).toBeUndefined();
    expect(await response.text()).toContain('data-testid="home-page"');
  });
});
