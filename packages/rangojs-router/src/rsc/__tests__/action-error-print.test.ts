/**
 * A server action that throws prints its original error to the server console
 * once, where it threw, whether or not an error boundary renders it, on the
 * JS path and the no-JS (PE) path. The client gets the action's error through
 * Flight; nothing else printed it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeServerAction } from "../server-action.js";
import { handleProgressiveEnhancement } from "../progressive-enhancement.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import type { HandlerContext } from "../handler-context.js";

const BOUNDARY = {
  segments: [],
  matched: ["err"],
  diff: ["err"],
  resolvedIds: ["err"],
  params: {},
  routeName: "boom",
};

function makeReqCtx(request: Request) {
  return createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  });
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a JS server action", () => {
  function jsCtx(options: {
    decode?: () => unknown;
    action?: () => unknown;
    boundary?: boolean;
  }) {
    return {
      version: "v-test",
      createTemporaryReferenceSet: () => ({}),
      decodeReply: options.decode ?? (() => []),
      loadServerAction: async () => options.action ?? (() => undefined),
      callOnError: vi.fn(),
      renderToReadableStream: () => new ReadableStream(),
      router: {
        id: "test",
        async matchError() {
          return options.boundary ? BOUNDARY : null;
        },
      },
    } as any;
  }

  function run(ctx: unknown) {
    const request = new Request("http://localhost/page?_rsc_action=a1", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "encoded-args",
    });
    const reqCtx = makeReqCtx(request);
    return runWithRequestContext(reqCtx, () =>
      executeServerAction(
        ctx as never,
        request,
        {} as never,
        new URL(request.url),
        "a1",
        { stream: () => ({}) } as never,
      ),
    );
  }

  it.each([
    ["no boundary", false],
    ["an error boundary", true],
  ])(
    "that throws prints the original error once (%s)",
    async (_label, boundary) => {
      const error = new Error("payment declined");

      await run(
        jsCtx({
          action: () => {
            throw error;
          },
          boundary,
        }),
      );

      expect(consoleError.mock.calls).toEqual([
        ["[RSC] Action error (a1) /page:", error],
      ]);
    },
  );

  it("whose arguments do not decode prints the decode error once", async () => {
    const error = new Error("unexpected end of Flight body");

    await run(
      jsCtx({
        decode: () => {
          throw error;
        },
      }),
    );

    expect(consoleError.mock.calls).toEqual([
      ["[RSC] Action decode error (a1) /page:", error],
    ]);
  });
});

describe("a no-JS (progressive enhancement) form action", () => {
  const ACTION_ID = "action-1";

  function peCtx(boundary: boolean, error: Error) {
    const closed = () =>
      new ReadableStream({ start: (controller) => controller.close() });
    return {
      version: "v-test",
      router: {
        id: "test-router",
        basename: undefined,
        rootLayout: undefined,
        resolvedStateCookieName: "rango-state",
        themeConfig: undefined,
        warmupEnabled: false,
        async match() {
          return {
            redirect: undefined,
            segments: [],
            matched: [],
            diff: [],
            resolvedIds: [],
            params: {},
          };
        },
        async matchError() {
          return boundary ? BOUNDARY : null;
        },
      },
      callOnError: vi.fn(),
      createTemporaryReferenceSet: () => ({}),
      decodeReply: () => {
        throw new Error("no encoded args (raw form POST)");
      },
      async loadServerAction() {
        return () => {
          throw error;
        };
      },
      decodeAction: async () => async () => ({ ok: true }),
      decodeFormState: async () => null,
      renderToReadableStream: () => closed(),
      loadSSRModule: async () => ({ renderHTML: async () => closed() }),
      resolveStreamMode: async () => "stream",
    } as unknown as HandlerContext<unknown>;
  }

  it.each([
    ["no boundary", false],
    ["an error boundary", true],
  ])(
    "that throws prints the original error once (%s)",
    async (_label, boundary) => {
      const error = new Error("PE action boom");
      const fd = new FormData();
      fd.set(`$ACTION_ID_${ACTION_ID}`, "");
      const request = new Request("http://localhost/pe", {
        method: "POST",
        body: fd,
      });
      const reqCtx = makeReqCtx(request);

      await runWithRequestContext(reqCtx, () =>
        handleProgressiveEnhancement(
          peCtx(boundary, error),
          request,
          {},
          new URL(request.url),
          false,
          reqCtx._handleStore,
          undefined,
        ),
      );

      expect(
        consoleError.mock.calls.filter((call: unknown[]) => call[1] === error),
      ).toEqual([["[RSC] Action error (action-1) /pe:", error]]);
    },
  );
});
