import { describe, it, expect, vi } from "vitest";

// createRouter's match path transitively imports @vitejs/plugin-rsc/rsc; stub it
// (these tests never render RSC). Mirrors src/testing/__tests__/dispatch.test.ts.
vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  createFromReadableStream: vi.fn(),
  renderToReadableStream: vi.fn(),
  loadServerAction: vi.fn(),
  decodeReply: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
  createTemporaryReferenceSet: vi.fn(),
}));

import { Static } from "../static-handler.js";
import { Prerender } from "../prerender.js";
import {
  DEV_DISCOVERY_EPOCH_HEADER,
  DEV_DISCOVERY_PROBE_HEADER,
} from "../dev-discovery-protocol.js";
import { createRouter } from "../router.js";
import { urls } from "../urls/urls-function.js";
import { dispatch } from "../testing/dispatch.js";

// Static()'s $$id is injected by the Vite plugin at build; in a bare test it is
// absent, so Static() assigns a process-stable runtime fallback id (mirroring
// createHandle / createLoader / Prerender). The dev-throw is preserved. The
// fallback is inert: staticHandlerId is read only during RSC serving, never in
// dispatch / assertGeneratedRoutesMatch, and the build manifest keys on the
// plugin-injected id (the fallback never fires under the plugin).
describe("Static bare-test $$id fallback", () => {
  it("constructs without a plugin-injected $$id under a test runner", () => {
    const def = Static(() => null);
    expect(def.__brand).toBe("staticHandler");
    expect(def.$$id).toMatch(/^__rango_runtime_static_\d+$/);
  });

  it("assigns a distinct id per call (process-stable counter)", () => {
    expect(Static(() => null).$$id).not.toBe(Static(() => null).$$id);
  });

  it("throws outside a test runner (a real build) for a missing id", () => {
    // No VITEST = a real build/dev: a missing id means an unsupported handler
    // shape the plugin skipped — fail loud rather than mask it with a synthetic
    // id (which would silently miss the static manifest). Restores the pre-PR
    // safety net that dev-only gating removed.
    const prev = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => Static(() => null)).toThrow(/missing \$\$id/);
    } finally {
      process.env.VITEST = prev;
    }
  });

  it("lets a whole router with Static() + Prerender() routes construct + dispatch (no missing-$$id)", async () => {
    // Before the fallback this threw "missing $$id" at construction. Now the
    // router builds; dispatch serves the response route and reports the Static/
    // Prerender routes as RSC routes (the SAME error a consumer gets in prod
    // tooling), proving construction succeeded rather than failing on the id.
    const router = createRouter<{}>({}).routes(
      urls(({ path }) => [
        path.json("/api/ok", () => ({ ok: true }), { name: "api.ok" }),
        path(
          "/static",
          Static(() => null),
          { name: "static.page" },
        ),
        path(
          "/pre",
          Prerender(() => null),
          { name: "pre.page" },
        ),
      ]),
    ) as Parameters<typeof dispatch>[0];

    const res = await dispatch(router, { request: "/api/ok" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    await expect(dispatch(router, { request: "/static" })).rejects.toThrow(
      /does not render RSC routes/,
    );
    await expect(dispatch(router, { request: "/pre" })).rejects.toThrow(
      /does not render RSC routes/,
    );
  });
});

describe("Cloudflare dev discovery probe", () => {
  it("reports the epoch captured by the active router", async () => {
    const globals = globalThis as typeof globalThis & {
      __RANGO_DEV_DISCOVERY_EPOCH?: unknown;
    };
    const previousEpoch = globals.__RANGO_DEV_DISCOVERY_EPOCH;
    globals.__RANGO_DEV_DISCOVERY_EPOCH = 23;

    try {
      const router = createRouter({ id: "dev-discovery-probe" });
      const response = await router.fetch(
        new Request("http://localhost/", {
          headers: { [DEV_DISCOVERY_PROBE_HEADER]: "23" },
        }),
      );

      expect(response.headers.get(DEV_DISCOVERY_EPOCH_HEADER)).toBe("23");
    } finally {
      globals.__RANGO_DEV_DISCOVERY_EPOCH = previousEpoch;
    }
  });
});
