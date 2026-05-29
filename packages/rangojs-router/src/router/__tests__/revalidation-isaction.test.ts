/**
 * Tests that evaluateRevalidation exposes ctx.isAction() to revalidate
 * predicates, resolving an imported action reference's id the same way the
 * action boundary derives actionId ($id ?? $$id) so matching is form-agnostic
 * across dev and production.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../logging.js", () => ({
  debugLog: vi.fn(),
  pushRevalidationTraceEntry: vi.fn(),
  isTraceActive: () => false,
}));

vi.mock("../../server/request-context.js", () => ({
  _getRequestContext: () => ({ _prevRouteKey: undefined }),
}));

import { evaluateRevalidation } from "../revalidation.js";

function makeSegment(overrides?: Partial<any>): any {
  return {
    id: "seg-1",
    type: "route",
    params: {},
    belongsToRoute: true,
    ...overrides,
  };
}

function makeContext(): any {
  return {
    request: new Request("http://localhost/test"),
    env: {},
    params: {},
    pathname: "/test",
    url: new URL("http://localhost/test"),
    var: {},
    get: vi.fn(),
    set: vi.fn(),
    header: vi.fn(),
    use: vi.fn(),
  };
}

const ACTION_ID = "src/actions/cart.tsx#addToCart";

/**
 * Run evaluateRevalidation with an optional action and capture the predicate
 * arg object so tests can call args.isAction(...) directly.
 */
async function captureArgs(actionId?: string): Promise<any> {
  let captured: any;
  await evaluateRevalidation({
    segment: makeSegment(),
    prevParams: {},
    getPrevSegment: null,
    request: new Request("http://localhost/cart", { method: "POST" }),
    prevUrl: new URL("http://localhost/cart"),
    nextUrl: new URL("http://localhost/cart"),
    revalidations: [
      {
        name: "capture",
        fn: (args: any) => {
          captured = args;
          return true;
        },
      },
    ],
    routeKey: "cart",
    context: makeContext(),
    actionContext: actionId ? ({ actionId } as any) : undefined,
  });
  return captured;
}

// Production form: file-path $id (set by the expose-action-id plugin).
const addToCart = Object.assign(() => {}, {
  $id: ACTION_ID,
  $$id: "abc123#addToCart",
});
const removeFromCart = Object.assign(() => {}, {
  $id: "src/actions/cart.tsx#removeFromCart",
  $$id: "def456#removeFromCart",
});

describe("ctx.isAction()", () => {
  it("matches a single action reference by its file-path $id", async () => {
    const args = await captureArgs(ACTION_ID);
    expect(args.isAction(addToCart)).toBe(true);
  });

  it("returns false for a non-matching action", async () => {
    const args = await captureArgs(ACTION_ID);
    expect(args.isAction(removeFromCart)).toBe(false);
  });

  it("is variadic — true if any reference matches", async () => {
    const args = await captureArgs(ACTION_ID);
    expect(args.isAction(removeFromCart, addToCart)).toBe(true);
  });

  it("matches any export of a namespace import, ignoring non-action members", async () => {
    const args = await captureArgs(ACTION_ID);
    const CartActions = { addToCart, removeFromCart, PAGE_SIZE: 20 } as any;
    expect(args.isAction(CartActions)).toBe(true);

    const OtherActions = { removeFromCart, PAGE_SIZE: 20 } as any;
    expect(args.isAction(OtherActions)).toBe(false);
  });

  it("falls back to $$id when $id is absent (dev / hash form)", async () => {
    const hashOnly = Object.assign(() => {}, { $$id: ACTION_ID });
    const args = await captureArgs(ACTION_ID);
    expect(args.isAction(hashOnly)).toBe(true);
  });

  it("prefers $id over $$id (mirrors the action boundary's resolution)", async () => {
    // $$id equals the current actionId but $id does not — $id wins, so no match.
    const mixed = Object.assign(() => {}, {
      $id: "src/actions/other.tsx#x",
      $$id: ACTION_ID,
    });
    const args = await captureArgs(ACTION_ID);
    expect(args.isAction(mixed)).toBe(false);
  });

  it("returns false on plain navigation (no action)", async () => {
    const args = await captureArgs(undefined);
    expect(args.isAction(addToCart)).toBe(false);
    expect(args.isAction()).toBe(false);
  });

  it("returns false for a reference with no resolvable id", async () => {
    const bare = () => {};
    const args = await captureArgs(ACTION_ID);
    expect(args.isAction(bare)).toBe(false);
  });
});
