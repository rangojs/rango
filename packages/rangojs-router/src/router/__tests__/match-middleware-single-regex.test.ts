import { describe, it, expect, vi } from "vitest";
import {
  matchMiddleware,
  compileMiddlewarePattern,
  extractParams,
} from "../middleware.js";
import type { MiddlewareEntry } from "../middleware-types.js";

// A3: matchMiddleware is on the per-request hot path (runs against every global
// middleware). It must run the scope regex EXACTLY ONCE per matching entry, not
// test() then match() (a second full regex pass over the same string).
//
// `pathname.match(regex)` and `regex.test(pathname)` both route through the
// RegExp's `exec`, so counting exec calls counts total regex executions.
function makeEntry(pattern: string): MiddlewareEntry {
  const { regex, paramNames } = compileMiddlewarePattern(pattern);
  return {
    pattern,
    regex,
    paramNames,
    handler: async (_ctx, next) => next(),
  } as MiddlewareEntry;
}

describe("matchMiddleware single regex execution (A3)", () => {
  it("runs the scope regex once for a matching param-bearing entry", () => {
    const entry = makeEntry("/users/:id");
    const execSpy = vi.spyOn(entry.regex!, "exec");

    const matches = matchMiddleware("/users/42", [entry]);

    expect(matches).toHaveLength(1);
    expect(matches[0].params).toEqual({ id: "42" });
    // Exactly one regex execution: the old code ran test() then match() = 2.
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it("runs the scope regex once for a matching param-less entry", () => {
    const entry = makeEntry("/admin");
    const execSpy = vi.spyOn(entry.regex!, "exec");

    const matches = matchMiddleware("/admin", [entry]);

    expect(matches).toHaveLength(1);
    expect(matches[0].params).toEqual({});
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it("runs the scope regex once for a non-matching entry (no second pass)", () => {
    const entry = makeEntry("/users/:id");
    const execSpy = vi.spyOn(entry.regex!, "exec");

    const matches = matchMiddleware("/posts/42", [entry]);

    expect(matches).toHaveLength(0);
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it("pattern-less (regex null) middleware still matches all with no execution", () => {
    const entry: MiddlewareEntry = {
      pattern: null,
      regex: null,
      paramNames: [],
      handler: async (_ctx, next) => next(),
    };
    const matches = matchMiddleware("/anything", [entry]);
    expect(matches).toHaveLength(1);
    expect(matches[0].params).toEqual({});
  });

  it("extractParams stays usable as a standalone export", () => {
    const { regex, paramNames } = compileMiddlewarePattern("/users/:id");
    expect(extractParams("/users/7", regex, paramNames)).toEqual({ id: "7" });
    expect(extractParams("/nope", regex, paramNames)).toEqual({});
  });

  it("decodes param values the same way as extractParams", () => {
    const entry = makeEntry("/u/:email");
    const matches = matchMiddleware("/u/ivo%40example.com", [entry]);
    expect(matches[0].params).toEqual({ email: "ivo@example.com" });
  });
});
