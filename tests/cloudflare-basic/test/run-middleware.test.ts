import { describe, expect, it } from "vitest";
import { runMiddleware } from "@rangojs/router/testing";
import { setOverlayCookie } from "../src/middleware/cookie-overlay.js";

describe("runMiddleware against cloudflare-basic middleware", () => {
  // The REAL route middleware: it sets the `mw-overlay` cookie then calls next().
  // runMiddleware runs it through the router's real executeMiddleware, so the
  // Set-Cookie merge + next() pass-through behave exactly as in production.
  describe("setOverlayCookie (sets a cookie, passes through)", () => {
    it("passes through to the handler and emits the cookie", async () => {
      const { response, ctx, nextCalled } = await runMiddleware(
        setOverlayCookie,
        "/cookie-overlay",
      );
      expect(nextCalled).toBe(1); // ran the terminal handler (no short-circuit)
      expect(response.status).toBe(200);
      // ctx is the RequestContext the chain ran under (fixed during this
      // dogfood), so ctx.cookies() is available with no cast. NOTE: it returns a
      // Record<string,string> (property access), NOT the global cookies() jar
      // with .get()/.set() — a naming collision worth a docs note.
      expect(ctx.cookies()["mw-overlay"]).toBe("from-middleware");
      // ...and serialized onto the response as a Set-Cookie header.
      expect(
        response.headers
          .getSetCookie()
          .some((c) => c.startsWith("mw-overlay=from-middleware")),
      ).toBe(true);
    });

    it("forwards the downstream handler's response when it passes through", async () => {
      const { response, nextCalled } = await runMiddleware(
        setOverlayCookie,
        "/cookie-overlay",
        { next: async () => new Response("downstream", { status: 201 }) },
      );
      expect(nextCalled).toBe(1);
      expect(response.status).toBe(201);
      expect(await response.text()).toBe("downstream");
    });
  });

  // Infra-surface coverage: short-circuit semantics (return vs throw Response),
  // ordering, and prior-var visibility — the contract a richer consumer auth
  // middleware depends on. cloudflare-basic's own middleware are thin, so this
  // pins the surface; richer real-middleware dogfood lives in mini / e2e-basic.
  describe("middleware short-circuit + ordering contract", () => {
    it("short-circuits (nextCalled === 0) when a middleware returns a Response", async () => {
      const gate = async (
        ctx: { get: (k: string) => unknown },
        next: () => Promise<Response>,
      ) => {
        if (!ctx.get("user")) return new Response(null, { status: 401 });
        return next();
      };
      const { response, nextCalled } = await runMiddleware(gate, "/admin");
      expect(nextCalled).toBe(0);
      expect(response.status).toBe(401);
    });

    it("passes through when a prior var satisfies the gate", async () => {
      const gate = async (
        ctx: { get: (k: string) => unknown },
        next: () => Promise<Response>,
      ) => {
        if (!ctx.get("user")) return new Response(null, { status: 401 });
        return next();
      };
      const { response, nextCalled } = await runMiddleware(gate, "/admin", {
        vars: [["user", { id: 1 }]],
      });
      expect(nextCalled).toBe(1);
      expect(response.status).toBe(200);
    });

    it("runs an array of middleware in order, accumulating headers", async () => {
      const first = async (
        ctx: { header: (k: string, v: string) => void },
        next: () => Promise<Response>,
      ) => {
        ctx.header("x-first", "1");
        return next();
      };
      const second = async (
        ctx: { header: (k: string, v: string) => void },
        next: () => Promise<Response>,
      ) => {
        ctx.header("x-second", "2");
        return next();
      };
      const { response, nextCalled } = await runMiddleware(
        [first, second],
        "/chain",
      );
      expect(nextCalled).toBe(1);
      expect(response.headers.get("x-first")).toBe("1");
      expect(response.headers.get("x-second")).toBe("2");
    });
  });
});
