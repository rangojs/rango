import { describe, it, expect } from "vitest";
import { collectFallbackClientRefs } from "../collect-fallback-refs.js";

const CLIENT_REF = Symbol.for("react.client.reference");
const ELEMENT = Symbol.for("react.element");

// Minimal stand-ins for a plugin-rsc client-reference proxy and a React element.
const clientRef = (id: string) => ({ $$typeof: CLIENT_REF, $$id: id });
const el = (type: unknown, props: Record<string, unknown> = {}) => ({
  $$typeof: ELEMENT,
  type,
  props,
});
function ServerWrap() {
  return null;
}

function collected(boundary: unknown): string[] {
  const keys: string[] = [];
  collectFallbackClientRefs(boundary, (k) => keys.push(k));
  return keys;
}

describe("collectFallbackClientRefs", () => {
  it("collects a direct client element (and strips the #export suffix)", () => {
    expect(collected(el(clientRef("hash1#ErrBoundary")))).toEqual(["hash1"]);
  });

  it("collects a client boundary nested under a server wrapper element", () => {
    expect(
      collected(el(ServerWrap, { children: el(clientRef("hash2#Boundary")) })),
    ).toEqual(["hash2"]);
  });

  it("invokes a handler function and collects the nested client boundary", () => {
    // The real-world shape: a function returning a server provider around the
    // "use client" boundary, gated on the error prop.
    const handler = ({ error }: { error?: unknown }) =>
      el(ServerWrap, {
        children: error ? el(clientRef("hash3#Boundary")) : null,
      });
    expect(collected(handler)).toEqual(["hash3"]);
  });

  it("skips a handler that needs a real render context (throws) gracefully", () => {
    const handler = () => {
      throw new Error("needs request context");
    };
    expect(collected(handler)).toEqual([]);
  });

  it("ignores a pure server subtree (no client reference)", () => {
    expect(collected(el(ServerWrap, { children: el("div") }))).toEqual([]);
  });

  it("collects a client ref passed as a non-children prop (slot)", () => {
    expect(
      collected(el(ServerWrap, { fallback: el(clientRef("hash4#Slot")) })),
    ).toEqual(["hash4"]);
  });

  it("does not recurse into plain data props and does not crash", () => {
    expect(
      collected(
        el(clientRef("hash5#X"), {
          data: { big: "object", n: 1 },
          list: ["a", "b"],
        }),
      ),
    ).toEqual(["hash5"]);
  });

  it("handles arrays of children", () => {
    expect(
      collected(
        el(ServerWrap, {
          children: [el(clientRef("a#A")), "text", el(clientRef("b#B"))],
        }),
      ),
    ).toEqual(["a", "b"]);
  });
});
