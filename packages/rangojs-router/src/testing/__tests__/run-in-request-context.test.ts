import { describe, it, expect } from "vitest";
import {
  runInRequestContext,
  runWithRequestContext,
  createTestRequestContext,
} from "../index.js";
import { getRequestContext } from "../../server/request-context.js";
import { createVar } from "../../context-var.js";

// runInRequestContext is the reachable entry for the advanced action-auth path:
// a server action has no loader context (so runLoader is the wrong shape) yet
// still needs a real request context to read the request cookie and resolve
// getRequestContext(). Before this, createTestRequestContext built a ctx that
// could not be entered (runWithRequestContext was exported from no public entry).

describe("runInRequestContext", () => {
  it("enters a context so getRequestContext() resolves inside fn", async () => {
    const seen = await runInRequestContext(() => getRequestContext().method);
    expect(seen).toBe("GET");
  });

  it("authenticates off the request Cookie (the action-auth case)", async () => {
    // Mirrors authorizeTenantAction: read the session cookie, then decide.
    async function authorize(): Promise<{ session: string } | null> {
      const sid = getRequestContext().cookies()["sid"];
      if (!sid) return null;
      return { session: sid };
    }

    const authed = await runInRequestContext(() => authorize(), {
      request: new Request("https://app.test/admin", {
        headers: { Cookie: "sid=abc123" },
      }),
    });
    expect(authed).toEqual({ session: "abc123" });

    const anon = await runInRequestContext(() => authorize(), {
      request: new Request("https://app.test/admin"),
    });
    expect(anon).toBeNull();
  });

  it("surfaces env and seeded vars to fn", async () => {
    const userVar = createVar<{ id: number }>();
    const result = await runInRequestContext(
      () => {
        const ctx = getRequestContext<{ region: string }>();
        return {
          region: ctx.env.region,
          // tuple form seeds by the createVar() handle, read back by the handle
          user: ctx.get(userVar),
        };
      },
      { env: { region: "eu" }, vars: [[userVar, { id: 7 }]] },
    );
    expect(result).toEqual({ region: "eu", user: { id: 7 } });
  });

  it("keeps the context active across awaits in an async fn", async () => {
    const result = await runInRequestContext(
      async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        // getRequestContext() must still resolve after awaits (AsyncLocalStorage).
        return getRequestContext().url.pathname;
      },
      { request: "https://app.test/checkout" },
    );
    expect(result).toBe("/checkout");
  });

  it("passes fn's return value straight through and exposes the ctx arg", async () => {
    const value = await runInRequestContext((ctx) => ctx.cookies()["t"], {
      request: new Request("https://app.test/", {
        headers: { Cookie: "t=42" },
      }),
    });
    expect(value).toBe("42");
  });

  it("does not leak the context outside the runner", async () => {
    await runInRequestContext(() => getRequestContext().method);
    expect(() => getRequestContext()).toThrow();
  });
});

describe("runWithRequestContext re-export", () => {
  it("enters a ctx built with createTestRequestContext (the low-level path)", () => {
    const { ctx } = createTestRequestContext({
      request: new Request("https://app.test/", {
        headers: { Cookie: "sid=zzz" },
      }),
    });
    const sid = runWithRequestContext(
      ctx,
      () => getRequestContext().cookies()["sid"],
    );
    expect(sid).toBe("zzz");
  });
});
