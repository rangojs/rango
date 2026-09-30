import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateInterceptWhen } from "../intercept-resolution.js";
import type {
  InterceptEntry,
  InterceptSelectorContext,
} from "../../server/context.js";

/**
 * A throwing intercept `when` selector yields the conservative default: no
 * intercept (the full page renders), logged with the route name. It never
 * fails the request.
 */
function entry(when: InterceptEntry["when"]): InterceptEntry {
  return {
    slotName: "@modal",
    routeName: "item",
    handler: null,
    middleware: [],
    loader: [],
    when,
  };
}

const ctx = {
  from: {
    url: new URL("http://localhost/list"),
    params: {},
    routeName: "list",
  },
  to: {
    url: new URL("http://localhost/item/1"),
    params: { id: "1" },
    routeName: "shop.item",
  },
  request: new Request("http://localhost/item/1"),
  env: {},
  segments: { path: [], ids: [] },
} as unknown as InterceptSelectorContext;

afterEach(() => vi.restoreAllMocks());

describe("evaluateInterceptWhen: a throwing selector", () => {
  it("does not intercept and logs the route name", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("boom");
    expect(
      evaluateInterceptWhen(
        entry([
          () => {
            throw boom;
          },
        ]),
        ctx,
        false,
      ),
    ).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('"shop.item"');
    expect(error.mock.calls[0]![1]).toBe(boom);
  });

  it("stops at the throw: later selectors do not run", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const later = vi.fn(() => true);
    expect(
      evaluateInterceptWhen(
        entry([
          () => {
            throw new Error("boom");
          },
          later,
        ]),
        ctx,
        false,
      ),
    ).toBe(false);
    expect(later).not.toHaveBeenCalled();
  });
});
