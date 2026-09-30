import { describe, expect, it } from "vitest";
import {
  runTransitionWhen,
  withLocationStateKey,
} from "@rangojs/router/testing";
import { pprExecWhen, txSrcWhen } from "../src/components/transition-when.js";
import { PprExecMark, TxWhenState } from "../src/location-states.js";

// No Vite plugin in this project, so the definitions carry no key.
withLocationStateKey(TxWhenState, "TxWhenState");
withLocationStateKey(PprExecMark, "PprExecMark");

/**
 * Dogfood of runTransitionWhen against cloudflare-basic's real browser
 * predicates (src/components/transition-when.ts): the same { kind, from, to }
 * context the browser builds, including typed location state read with
 * Def.read(ctx.to).
 */
describe("transition({ when }) predicates (cloudflare-basic)", () => {
  it("txSrcWhen holds unless the navigation leaves n=b", () => {
    expect(
      runTransitionWhen(txSrcWhen, {
        from: { url: "/tx-src/a", params: { n: "a" }, routeName: "txSrc" },
        to: { url: "/tx-src/b", params: { n: "b" }, routeName: "txSrc" },
      }).applied,
    ).toBe(true);
    expect(
      runTransitionWhen(txSrcWhen, {
        from: { url: "/tx-src/b", params: { n: "b" } },
        to: { url: "/tx-src/a", params: { n: "a" } },
      }).gatedOff,
    ).toBe(true);
  });

  it("txSrcWhen reads TxWhenState from the destination with Def.read(ctx.to)", () => {
    const result = runTransitionWhen(txSrcWhen, {
      from: { url: "/tx-src/a", params: { n: "a" } },
      to: {
        url: "/tx-src/f",
        params: { n: "f" },
        state: [TxWhenState({ animate: false })],
      },
    });
    expect(TxWhenState.read(result.context.to)).toEqual({ animate: false });
    expect(result.gatedOff).toBe(true);
  });

  it("pprExecWhen gates off ?transition=drop and sees the middleware mark in to.state", () => {
    const kept = runTransitionWhen(pprExecWhen, {
      from: "/",
      to: {
        url: "/ppr-shell/exec-matrix",
        state: [PprExecMark({ middleware: 3 })],
      },
    });
    expect(kept.applied).toBe(true);
    expect(PprExecMark.read(kept.context.to)).toEqual({ middleware: 3 });

    expect(
      runTransitionWhen(pprExecWhen, {
        from: "/",
        to: "/ppr-shell/exec-matrix?transition=drop",
      }).gatedOff,
    ).toBe(true);
  });
});
