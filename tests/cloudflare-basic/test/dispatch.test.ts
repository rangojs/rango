import { describe, expect, it } from "vitest";
import { dispatch } from "@rangojs/router/testing";
import { createRouter } from "@rangojs/router";
import { apiPatterns } from "../src/api/urls.js";
import type { AppBindings } from "../src/env.js";

// Dogfood `dispatch` against the cloudflare-basic app's REAL API route handlers.
//
// Why a router built from `apiPatterns` rather than `import { router }`:
// importing the full app router (src/router.tsx) pulls Prerender()/createLoader()
// calls whose build-time-injected `$$id` only exists under the rango Vite plugin
// transform — in bare vitest the real Prerender() throws "missing $$id". The
// app's API include (src/api/urls.tsx) is Prerender-free and uses only
// path.json(...) with real handler bodies, so it imports and dispatches cleanly
// with just the vitest.config.ts aliases (no per-file vi.mock). This is the
// realistic consumer pattern for unit-testing response/API routes.
//
// (See test/FINDINGS.md for the full account of why the documented "mock
// plugin-rsc + import your router" recipe is insufficient for a real app.)
// dispatch() now accepts the public Rango router type directly (no cast) —
// fixed as part of this dogfood.
const router = createRouter<AppBindings>({}).routes(apiPatterns);

const env = {
  KV: {
    get: async () => null,
    put: async () => undefined,
    list: async () => ({ keys: [] as { name: string }[] }),
    delete: async () => undefined,
  },
} as unknown as AppBindings;

describe("dispatch against cloudflare-basic API route handlers", () => {
  it("serializes /health and auto-wraps the value under { data }", async () => {
    const res = await dispatch(router, { request: "/health", env });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json;charset=utf-8",
    );
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("ok");
    expect(typeof body.data.status).toBe("string");
  });

  it("serializes the full /products list from the real handler", async () => {
    const res = await dispatch(router, { request: "/products", env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; name: string; price: number }>;
    };
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toMatchObject({
      id: "1",
      name: "Widget",
      price: 9.99,
    });
  });

  it("resolves the :id route param in /products/:id", async () => {
    const res = await dispatch(router, { request: "/products/2", env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; name: string; description: string };
    };
    expect(body.data.id).toBe("2");
    expect(body.data.name).toBe("Gadget");
    expect(body.data.description).toContain("2");
  });

  it("maps the handler's thrown RouterError to a 404 + typed JSON envelope", async () => {
    // The real handler does: throw new RouterError("NOT_FOUND", ..., { status: 404 })
    const res = await dispatch(router, { request: "/products/999", env });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(
      "application/json;charset=utf-8",
    );
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("999");
  });

  it("returns 404 for an unmatched path (this router has no catch-all)", async () => {
    const res = await dispatch(router, { request: "/not-a-route", env });
    expect(res.status).toBe(404);
  });
});
