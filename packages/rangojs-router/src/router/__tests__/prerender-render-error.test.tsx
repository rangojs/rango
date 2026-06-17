// Issue #587: when a Prerender route's render throws at build time, the router's
// error boundary (in resolveAllSegments) used to catch it and turn it into a
// `type: "error"` segment. matchForPrerender then serialized that error page as a
// normal prerender artifact (the build logged OK and the frozen error page was
// served as an HTTP 200). The failure was silent: status/CI checks saw a 200.
//
// The fix makes the pre-render path re-throw render failures (throwOnError) so the
// build can fail, warn, or skip — never bake the error page. This suite pins:
//   1. a render error is surfaced (rejects with the ORIGINAL error), not baked;
//   2. `throw new Skip()` inside a render fn propagates as a Skip (so the build
//      skips that URL) instead of being baked as an error page;
//   3. a HEALTHY render still serializes normally (the guard only fires on error).
import { beforeEach, describe, expect, test, vi } from "vitest";

// matchForPrerender's serialize step imports `@vitejs/plugin-rsc/rsc`. Mock it
// with a spy that returns a real (tiny) ReadableStream, so a HEALTHY prerender
// still serializes — the spy lets us assert the bake step never runs for a route
// whose render errored. (vi.hoisted so the factory can close over the spy.)
const { renderSpy } = vi.hoisted(() => ({
  renderSpy: vi.fn(
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("BAKED"));
          controller.close();
        },
      }),
  ),
}));

vi.mock("@vitejs/plugin-rsc/rsc", () => ({
  createFromReadableStream: vi.fn(),
  renderToReadableStream: renderSpy,
  loadServerAction: vi.fn(),
  decodeReply: vi.fn(),
  decodeAction: vi.fn(),
  decodeFormState: vi.fn(),
  createTemporaryReferenceSet: vi.fn(() => ({})),
}));

import { Prerender } from "../../prerender.js";
import { Skip } from "../../errors.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";

type InternalRouter = {
  matchForPrerender: (
    pathname: string,
    params: Record<string, string>,
  ) => Promise<unknown>;
};

function routerWith(
  pattern: string,
  name: string,
  render: (ctx: unknown) => unknown,
) {
  return createRouter<Record<string, never>>({}).routes(
    urls(({ path }) => [path(pattern, Prerender(render as any), { name })]),
  ) as unknown as InternalRouter;
}

describe("matchForPrerender surfaces prerender render errors (#587)", () => {
  beforeEach(() => {
    renderSpy.mockClear();
  });

  test("a render error is surfaced to the build, not baked into a 200 error page", async () => {
    // buildEnv is unconfigured here, so ctx.env throws the exact #587 error.
    const router = routerWith(
      "/boom",
      "boom",
      (ctx) => (ctx as { env: { REGION: string } }).env.REGION,
    );

    // The ORIGINAL render error must reach the build (the message names the
    // cause), and the serialize/bake step must never run for the errored route.
    await expect(router.matchForPrerender("/boom", {})).rejects.toThrow(
      /ctx\.env is not available during pre-rendering/,
    );
    expect(renderSpy).not.toHaveBeenCalled();
  });

  test("throw new Skip() inside a render fn propagates as a Skip (URL is skipped, not baked)", async () => {
    const router = routerWith("/draft", "draft", () => {
      throw new Skip("article is a draft");
    });

    let err: unknown;
    try {
      await router.matchForPrerender("/draft", {});
    } catch (e) {
      err = e;
    }
    // expandPrerenderRoutes keys off `err.name === "Skip"` to SKIP a URL rather
    // than fail the build, so the Skip must survive as a Skip instance.
    expect(err).toBeInstanceOf(Skip);
    expect((err as Skip).message).toMatch(/draft/);
    expect(renderSpy).not.toHaveBeenCalled();
  });

  test("a healthy Prerender render still serializes normally", async () => {
    const router = routerWith("/ok", "ok", () => "hello");

    const result = (await router.matchForPrerender("/ok", {})) as {
      segments: unknown[];
      routeName: string;
    } | null;

    expect(result).not.toBeNull();
    expect(result!.routeName).toBe("ok");
    // The guard only fires on error: a healthy render reaches the serializer.
    expect(renderSpy).toHaveBeenCalled();
  });
});
