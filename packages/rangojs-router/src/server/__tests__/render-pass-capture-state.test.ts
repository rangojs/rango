/**
 * Which derived render pass has a ShellCaptureState (rsc/shell-capture.ts),
 * and whose writes reach it. A shell capture creates its own
 * (RENDER_PASS_FIELDS["shell-capture"]). A stale route cache() record the
 * capture reads starts a background re-render derived from the capture
 * (router/match-middleware/background-revalidation.ts): that pass renders as
 * a capture, and what it records stays its own, so a guard trip in the
 * refresh does not refuse the capture.
 */
import { describe, expect, it } from "vitest";
import { cookies } from "../cookie-store.js";
import { createHandleStore } from "../handle-store.js";
import { deriveRenderPass } from "../render-pass.js";
import { runWithRequestContext } from "../request-context.js";
import { makeRequestContext } from "../../__tests__/kit/request-context.js";

function captureOf(base = makeRequestContext()) {
  return deriveRenderPass(base, "shell-capture", {
    handleStore: createHandleStore(),
    identity: undefined,
    recording: undefined,
  });
}

function backgroundOf(base: ReturnType<typeof makeRequestContext>) {
  return deriveRenderPass(base, "background-revalidation", {
    handleStore: createHandleStore(),
    sink: makeRequestContext(),
  });
}

describe("ShellCaptureState on derived render passes", () => {
  it("a shell capture owns a fresh one; the request it derives from has none", () => {
    const base = makeRequestContext();
    const capture = captureOf(base);

    expect(Object.hasOwn(capture, "_shellCaptureState")).toBe(true);
    expect(capture._shellCaptureState).toEqual({
      run: true,
      forVisitor: undefined,
      loaderRecords: new Map(),
      unrecordedLoaderPush: undefined,
      loaderLanes: undefined,
      guardTripped: undefined,
      guardTrippedLoaderId: undefined,
      routeRecordWindow: undefined,
    });
    expect(base._shellCaptureState).toBeUndefined();
    expect(captureOf(base)._shellCaptureState).not.toBe(
      capture._shellCaptureState,
    );
  });

  it("a background re-render of the request has none", () => {
    expect(backgroundOf(makeRequestContext())._shellCaptureState).toBe(
      undefined,
    );
  });

  it("a background re-render a capture starts reads the capture's state live; its guard trip stays its own", () => {
    const capture = captureOf();
    const state = capture._shellCaptureState!;
    state.forVisitor = true;
    const pass = backgroundOf(capture);
    const passState = pass._shellCaptureState!;

    expect(Object.hasOwn(pass, "_shellCaptureState")).toBe(true);
    expect(passState).not.toBe(state);
    expect(passState.run).toBe(true);
    expect(passState.forVisitor).toBe(true);
    expect(passState.loaderRecords).toBe(state.loaderRecords);
    // A write the capture makes after the pass exists reads through.
    state.loaderLanes = new Map([["L", "bake"]]);
    expect(passState.loaderLanes).toBe(state.loaderLanes);

    runWithRequestContext(pass, () => {
      expect(() => cookies()).toThrow(/capturing a shared shell/i);
    });
    expect(passState.guardTripped?.surface).toBe("cookies()");
    expect(state.guardTripped).toBeUndefined();
  });
});
