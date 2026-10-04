import { describe, expect, it } from "vitest";
import { makeIsAction, resolveActionRefId } from "../is-action.js";
import {
  ACTION_BIND_HELPER_NAME,
  ACTION_BIND_HELPER_SOURCE,
} from "../../vite/plugins/expose-action-id.js";

/**
 * Materialize the EXACT code the expose-action-id plugin injects: the helper
 * source verbatim plus the conditional own-bind install the wrapping IIFE
 * emits. Tests below run the shipped snippet, not a re-implementation.
 */
function installOwnBind<T extends Function>(fn: T): T {
  const install = new Function(
    "fn",
    `${ACTION_BIND_HELPER_SOURCE}\n` +
      `if (!Object.prototype.hasOwnProperty.call(fn, "bind")) fn.bind = ${ACTION_BIND_HELPER_NAME};\n` +
      `return fn;`,
  );
  return install(fn) as T;
}

const ACTION_ID = "src/actions/cart.ts#addToCart";

const addToCart = Object.assign(() => {}, {
  $id: ACTION_ID,
  $$id: "abc123#addToCart",
});
const removeFromCart = Object.assign(() => {}, {
  $id: "src/actions/cart.ts#removeFromCart",
  $$id: "def456#removeFromCart",
});

describe("makeIsAction()", () => {
  it("matches a single reference, variadic refs, a namespace, and an object literal", () => {
    const isAction = makeIsAction(ACTION_ID);
    expect(isAction(addToCart)).toBe(true);
    expect(isAction(removeFromCart)).toBe(false);
    expect(isAction(removeFromCart, addToCart)).toBe(true);
    expect(isAction({ addToCart, removeFromCart, PAGE_SIZE: 20 })).toBe(true);
    expect(isAction({ removeFromCart, PAGE_SIZE: 20 })).toBe(false);
    expect(
      isAction({
        Cart: { addToCart, removeFromCart },
        Order: { PAGE_SIZE: 20 },
      }),
    ).toBe(true);
  });

  it("bounds the object walk at grouped-namespace depth", () => {
    const isAction = makeIsAction(ACTION_ID);
    // Supported: namespace (depth 1) and grouped namespaces (depth 2).
    expect(isAction({ Cart: { addToCart } })).toBe(true);
    // Beyond the cap: an arbitrary deep object must not trigger a full walk.
    expect(isAction({ a: { b: { c: { addToCart } } } })).toBe(false);
  });

  it("treats a throwing getter as no-match instead of aborting the predicate", () => {
    const trap = Object.defineProperty({}, "boom", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    expect(makeIsAction(ACTION_ID)(trap)).toBe(false);
    // A sibling value still matches after the trapped node is skipped.
    expect(makeIsAction(ACTION_ID)({ trap, addToCart })).toBe(true);
  });
});

describe("expose-action-id own bind helper (browser stubs)", () => {
  it("preserves $id/$$id across bind, chains, and keeps thisArg/args", () => {
    const stub = installOwnBind(
      Object.assign(
        function (this: unknown, ...args: unknown[]) {
          return [this, ...args];
        },
        { $$id: "abc123#addToCart" },
      ),
    );
    const bound = stub.bind(null, 1) as typeof stub;
    expect(resolveActionRefId(bound)).toBe("abc123#addToCart");
    expect(makeIsAction("abc123#addToCart")(bound)).toBe(true);
    const doubly = bound.bind(null, 2) as typeof stub;
    expect(resolveActionRefId(doubly)).toBe("abc123#addToCart");
    expect(doubly(3)).toEqual([null, 1, 2, 3]);

    const greet = installOwnBind(function (this: { n: string }): string {
      return this.n;
    });
    expect(greet.bind({ n: "x" })()).toBe("x");
  });

  it("never overrides an existing own bind (edge/node RSDW references)", () => {
    const own = (): string => "own";
    const edgeRef = Object.assign(() => {}, { $$id: "x#y" });
    Object.defineProperty(edgeRef, "bind", { value: own });
    installOwnBind(edgeRef);
    expect(edgeRef.bind).toBe(own);
  });

  it("leaves the global Function.prototype.bind untouched", () => {
    expect(Function.prototype.bind.name).toBe("bind");
    expect(String(Function.prototype.bind)).toContain("[native code]");
  });
});

describe("makeIsAction() action context", () => {
  it("bare isAction() is true only while an action is in flight", () => {
    expect(makeIsAction(ACTION_ID)()).toBe(true);
    expect(makeIsAction(undefined)()).toBe(false);
    expect(makeIsAction(undefined)(addToCart)).toBe(false);
    expect(makeIsAction(undefined, true)()).toBe(true);
    expect(makeIsAction(undefined, true)(addToCart)).toBe(false);
    expect(makeIsAction(ACTION_ID, false)()).toBe(false);
  });

  it("prefers $id over $$id, falling back to $$id when $id is absent", () => {
    expect(resolveActionRefId(addToCart)).toBe(ACTION_ID);
    const hashOnly = Object.assign(() => {}, { $$id: ACTION_ID });
    expect(resolveActionRefId(hashOnly)).toBe(ACTION_ID);
    const mixed = Object.assign(() => {}, {
      $id: "src/actions/other.ts#x",
      $$id: ACTION_ID,
    });
    expect(resolveActionRefId(mixed)).toBe("src/actions/other.ts#x");
    expect(makeIsAction(ACTION_ID)(mixed)).toBe(false);
    expect(makeIsAction(ACTION_ID)(hashOnly)).toBe(true);
  });
});
