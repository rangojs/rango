import { describe, it, expect, vi, afterEach } from "vitest";
import { attachTransitionWhen } from "../attach-transition-when.js";
import { applyViewTransitionDefault } from "../../router/segment-resolution/view-transition-default.js";
import {
  enableTransitionWhenValidation,
  resetTransitionWhenValidation,
} from "../../transition-when-ref.js";
import type { ResolvedSegment } from "../../types/segments.js";
import type { TransitionWhenRecord } from "../../router/transition-when.js";

function ctxWith(refs: Record<string, TransitionWhenRecord>) {
  return {
    _transitionWhenRefs: new Map(Object.entries(refs)),
  } as never;
}

function clientRef<T extends Function>(fn: T): T {
  return Object.assign(fn, { $$typeof: Symbol.for("react.client.reference") });
}

afterEach(() => resetTransitionWhenValidation());

describe("attachTransitionWhen", () => {
  it("strips `when` from the storable config and re-attaches it before Flight without mutating it", () => {
    const when = vi.fn(() => true);
    const stored = applyViewTransitionDefault({ enter: "fade", when }, false);
    expect(stored).toEqual({ enter: "fade", viewTransition: false });
    const segment = {
      id: "M0R1",
      namespace: "r",
      type: "route",
      index: 0,
      component: null,
      transition: stored,
    } as ResolvedSegment;

    const [attached] = attachTransitionWhen(
      [segment],
      ctxWith({ M0R1: { when, site: {} } }),
    );
    expect(attached!.transition).toEqual({
      enter: "fade",
      viewTransition: false,
      when,
    });
    expect(segment.transition).toBe(stored);
    expect(when).not.toHaveBeenCalled();
  });

  it("attaches only to segments that carry a transition", () => {
    const when = () => true;
    const segments = [
      { id: "L0", type: "layout" },
      { id: "L0R0", type: "route", transition: {} },
    ] as ResolvedSegment[];
    const out = attachTransitionWhen(
      segments,
      ctxWith({ L0: { when, site: {} }, L0R0: { when, site: {} } }),
    );
    expect(out[0]).toBe(segments[0]);
    expect(out[1]!.transition).toEqual({ when });
  });

  it("throws the discovery error for a server function under strict validation, instead of dropping it", () => {
    enableTransitionWhenValidation();
    const segments = [
      { id: "L0R0", type: "route", transition: {} },
    ] as ResolvedSegment[];
    const site = { routeName: "product", pattern: "/product/:id" };

    expect(() =>
      attachTransitionWhen(
        segments,
        ctxWith({ L0R0: { when: () => true, site } }),
      ),
    ).toThrow(
      'transition({ when }) on route "product" (/product/:id) is not a client function.',
    );
    expect(
      attachTransitionWhen(
        segments,
        ctxWith({ L0R0: { when: clientRef(() => true), site } }),
      )[0]!.transition?.when,
    ).toBeTypeOf("function");
  });

  it("throws for a non-function even without strict validation", () => {
    const segments = [
      { id: "L0R0", type: "route", transition: {} },
    ] as ResolvedSegment[];
    expect(() =>
      attachTransitionWhen(
        segments,
        ctxWith({ L0R0: { when: "yes" as never, site: {} } }),
      ),
    ).toThrow("must be a function, got string");
  });
});
