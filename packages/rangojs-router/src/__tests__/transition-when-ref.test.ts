import { describe, it, expect, afterEach } from "vitest";
import {
  assertTransitionWhenShape,
  createClientUrlsWhenRef,
  createTransitionWhenError,
  enableTransitionWhenValidation,
  findTransitionWhenError,
  isClientReference,
  isTransitionWhenValidationEnabled,
  resetTransitionWhenValidation,
  resolveTransitionWhen,
  transitionWhenProblem,
} from "../transition-when-ref.js";

/** The shape plugin-rsc's registerClientReference gives a "use client" export. */
function clientRef<T extends Function>(fn: T): T {
  return Object.assign(fn, {
    $$typeof: Symbol.for("react.client.reference"),
    $$id: "src/when.ts#when",
  });
}

afterEach(() => resetTransitionWhenValidation());

describe("transition({ when }) references", () => {
  it("recognizes a client reference and a clientUrls reference", () => {
    expect(isClientReference(clientRef(() => true))).toBe(true);
    expect(isClientReference(() => true)).toBe(false);
    const ref = createClientUrlsWhenRef({}, "r1");
    expect(transitionWhenProblem(ref, true)).toBeNull();
  });

  it("resolves a clientUrls reference to the route's when, and nothing for a gone route", () => {
    const when = () => false;
    const definition = { routes: [{ id: "r1", transition: { when } }] };
    expect(
      resolveTransitionWhen(createClientUrlsWhenRef(definition, "r1")),
    ).toBe(when);
    expect(
      resolveTransitionWhen(createClientUrlsWhenRef(definition, "gone")),
    ).toBeUndefined();
    expect(resolveTransitionWhen(undefined)).toBeUndefined();
  });

  it("rejects a non-function everywhere, and a plain function only under strict validation", () => {
    expect(transitionWhenProblem(undefined, true)).toBeNull();
    expect(transitionWhenProblem("x", false)).toBe("not-a-function");
    expect(transitionWhenProblem(() => true, false)).toBeNull();
    expect(transitionWhenProblem(() => true, true)).toBe("server-function");
    expect(
      transitionWhenProblem(
        clientRef(() => true),
        true,
      ),
    ).toBeNull();
  });

  it("the DSL shape check throws a TypeError for a non-function only", () => {
    expect(() => assertTransitionWhenShape(() => true)).not.toThrow();
    expect(() => assertTransitionWhenShape(undefined)).not.toThrow();
    expect(() => assertTransitionWhenShape(null)).toThrow(TypeError);
    expect(() => assertTransitionWhenShape(true)).toThrow(
      "must be a function, got boolean",
    );
  });

  it("names the route and pattern, not the function source", () => {
    const error = createTransitionWhenError(
      (ctx: unknown) => ctx === "secret-source",
      "server-function",
      { routeName: "product", pattern: "/product/:id" },
    );
    expect(error.name).toBe("TransitionWhenError");
    expect(error.message).toContain(
      'transition({ when }) on route "product" (/product/:id) is not a client function.',
    );
    expect(error.message).toContain('"use client"');
    expect(error.message).not.toContain("secret-source");

    expect(
      createTransitionWhenError(() => true, "server-function", {
        routeName: "product",
        pattern: "/product/:id",
        entryType: "layout",
      }).message,
    ).toContain('on a layout of route "product" (/product/:id)');
    expect(
      createTransitionWhenError(3, "not-a-function", {
        routeName: "$path_x",
        pattern: "/x",
      }).message,
    ).toContain("on route /x must be a function, got number.");
  });

  it("strict validation is off until the plugin's generated module enables it", () => {
    expect(isTransitionWhenValidationEnabled()).toBe(false);
    enableTransitionWhenValidation();
    expect(isTransitionWhenValidationEnabled()).toBe(true);
  });

  it("finds the error through include wrapping, by name (another realm's class)", () => {
    const inner = Object.assign(new Error("bad when"), {
      name: "TransitionWhenError",
    });
    const wrapped = new Error("Failed to resolve include", { cause: inner });
    expect(findTransitionWhenError(wrapped)).toBe(inner);
    expect(findTransitionWhenError(new Error("other"))).toBeUndefined();
    expect(findTransitionWhenError("nope")).toBeUndefined();
  });
});
