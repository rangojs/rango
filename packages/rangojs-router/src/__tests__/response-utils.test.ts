import { describe, it, expect } from "vitest";
import { appendVaryAccept } from "../response-utils.js";

// D6: negotiated response routes (handler.ts response-route path) and negotiated
// RSC renders (handler.ts executeRenderWithMiddleware) each used to append
// `Vary: Accept` on top of a Vary the upstream layer already set, producing a
// duplicated token — `Vary: Accept, Accept` for response routes and
// `accept, X-Rango-State, X-RSC-Router-Client-Path, Accept` for RSC. Some
// proxies/CDNs treat a duplicated token as a distinct cache key. appendVaryAccept
// dedups, so the served Vary lists Accept exactly once.

function varyOf(response: Response): string | null {
  return response.headers.get("Vary");
}

describe("appendVaryAccept (D6)", () => {
  it("sets Vary: Accept when no Vary header exists", () => {
    const res = new Response(null);
    appendVaryAccept(res);
    expect(varyOf(res)).toBe("Accept");
  });

  it("does NOT duplicate Accept when Vary is already exactly Accept (response-route path)", () => {
    // Reproduces the old `Vary: Accept, Accept` from the double append.
    const res = new Response(null, { headers: { Vary: "Accept" } });
    appendVaryAccept(res);
    expect(varyOf(res)).toBe("Accept");
  });

  it("does NOT duplicate Accept when present (case-insensitive) in a multi-token Vary (RSC path)", () => {
    // Reproduces the old `accept, X-Rango-State, X-RSC-Router-Client-Path, Accept`.
    const res = new Response(null, {
      headers: { Vary: "accept, X-Rango-State, X-RSC-Router-Client-Path" },
    });
    appendVaryAccept(res);
    const tokens = varyOf(res)!
      .split(",")
      .map((t) => t.trim().toLowerCase());
    expect(tokens.filter((t) => t === "accept")).toHaveLength(1);
    expect(varyOf(res)).toBe("accept, X-Rango-State, X-RSC-Router-Client-Path");
  });

  it("appends Accept when the existing Vary does not include it", () => {
    const res = new Response(null, { headers: { Vary: "X-Rango-State" } });
    appendVaryAccept(res);
    const tokens = varyOf(res)!
      .split(",")
      .map((t) => t.trim().toLowerCase());
    expect(tokens).toContain("x-rango-state");
    expect(tokens.filter((t) => t === "accept")).toHaveLength(1);
  });

  it("tolerates surrounding whitespace in existing tokens", () => {
    const res = new Response(null, { headers: { Vary: " Accept " } });
    appendVaryAccept(res);
    const tokens = varyOf(res)!
      .split(",")
      .map((t) => t.trim().toLowerCase());
    expect(tokens.filter((t) => t === "accept")).toHaveLength(1);
  });
});
