/**
 * Which derived render pass has a ShellCaptureState (rsc/shell-capture.ts),
 * and whose writes reach it. A shell capture creates its own
 * (RENDER_PASS_FIELDS["shell-capture"]). A stale route cache() record the
 * capture reads starts a background re-render derived from the capture
 * (router/match-middleware/background-revalidation.ts): that pass writes a
 * route record, not the shell, so it has none and reads identity under
 * cache() rules.
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

  it("a background re-render a capture starts has none: the capture's identity guard does not apply", () => {
    const capture = captureOf();
    const pass = backgroundOf(capture);

    expect(Object.hasOwn(pass, "_shellCaptureState")).toBe(true);
    expect(pass._shellCaptureState).toBeUndefined();
    runWithRequestContext(pass, () => {
      expect(() => cookies()).not.toThrow();
    });
  });
});
