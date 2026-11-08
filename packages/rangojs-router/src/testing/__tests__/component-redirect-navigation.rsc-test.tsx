/**
 * A server component that throws redirect() on a client navigation.
 *
 * It is not a handler's return, so it never reaches handleHandlerResult:
 * React reports it to the Flight onError and writes an error row. An async
 * component's row lands after the response's status line committed, so the
 * server cannot turn it into the 204 + X-RSC-Redirect a handler's redirect
 * gets. The row's digest names the target instead, and the browser follows it
 * (segment-system.tsx renderSegments before the navigation commits,
 * root-error-boundary.tsx for one React meets while it renders).
 *
 * Pinned here through serveShellRequest: what the navigation's Flight answer
 * carries for each shape of redirect, and that an ordinary render error keeps
 * its plain error row and is still reported.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { withLocationStateKey } from "../location-state-key.js";
import {
  createLocationState,
  createRouter,
  redirect,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { decodedRedirectOf, type RenderRedirect } from "../../errors.js";

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true }),
  "Flash",
);
const FLASH = Flash.__rsc_ls_key;

function ThrowSync(): React.ReactNode {
  throw redirect("/target", 302);
}

async function ThrowAsync(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/target", 302);
}

async function ThrowAsyncPaid(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/target", { status: 303, state: [Flash({ text: "paid" })] });
}

const Counter = withLocationStateKey(
  createLocationState<{ n: bigint }>(),
  "Counter",
);

async function ThrowAsyncBigState(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/target", { state: [Counter({ n: 1n })] });
}

async function ThrowAsyncExternal(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("https://example.com/x", { external: true });
}

async function ThrowAsyncOffOrigin(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("https://evil.example/x");
}

async function Boom(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw new Error("render boom");
}

const patterns = urls(({ path, layout, loading }) => [
  layout(
    ({ children }: { children?: React.ReactNode }) => <main>{children}</main>,
    () => [
      path("/", () => <p>home</p>, { name: "home" }),
      path("/throw", () => <ThrowSync />, { name: "throw" }),
      path("/throw-async", () => <ThrowAsync />, { name: "throwAsync" }),
      path(
        "/throw-nested",
        () => (
          <section>
            <ThrowAsync />
          </section>
        ),
        { name: "throwNested" },
      ),
      path("/throw-paid", () => <ThrowAsyncPaid />, { name: "throwPaid" }),
      path("/throw-big-state", () => <ThrowAsyncBigState />, {
        name: "throwBigState",
      }),
      path("/throw-external", () => <ThrowAsyncExternal />, {
        name: "throwExternal",
      }),
      path("/throw-off-origin", () => <ThrowAsyncOffOrigin />, {
        name: "throwOffOrigin",
      }),
      path(
        "/handler-loading",
        async () => {
          await Promise.resolve();
          throw redirect("/target", 302);
        },
        { name: "handlerLoading" },
        () => [loading(<p>loading</p>)],
      ),
      path(
        "/handler-loading-return",
        async () => {
          await Promise.resolve();
          return redirect("/target", 302);
        },
        { name: "handlerLoadingReturn" },
        () => [loading(<p>loading</p>)],
      ),
      path("/boom", () => <Boom />, { name: "boom" }),
    ],
  ),
]);

function makeRouter(options: { basename?: string } = {}) {
  const onError = vi.fn();
  const router = createRouter({ onError, ...options }).routes(patterns);
  return { router, onError };
}

async function navigate(
  router: Parameters<typeof serveShellRequest>[0],
  path: string,
) {
  return serveShellRequest(router, path, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: true,
  });
}

/** The digest of every error row in a Flight body, in order. */
function errorRowDigests(body: string): unknown[] {
  return body
    .split("\n")
    .filter((line) => /^[0-9a-f]+:E/.test(line))
    .map(
      (line) =>
        (JSON.parse(line.slice(line.indexOf(":E") + 2)) as { digest?: unknown })
          .digest,
    );
}

/**
 * The redirects the browser reads off the body's error rows: React's Flight
 * client puts each row's digest on the error it decodes, and the router reads
 * the target from it.
 */
function redirectsIn(body: string): (RenderRedirect | undefined)[] {
  return errorRowDigests(body).map((digest) =>
    decodedRedirectOf(Object.assign(new Error("decoded"), { digest })),
  );
}

beforeEach(() => resetShellTestState());

describe("a component that throws redirect() on a client navigation", () => {
  it("an async component's error row names the target", async () => {
    const { router, onError } = makeRouter();
    const res = await navigate(router, "/throw-async");

    expect(res.response.status).toBe(200);
    expect(redirectsIn(res.body)).toEqual([{ to: "http://localhost/target" }]);
    // Control flow, not a rendering error.
    expect(onError).not.toHaveBeenCalled();
  });

  it("a synchronous component's error row names the target too", async () => {
    const { router, onError } = makeRouter();
    const res = await navigate(router, "/throw");

    expect(redirectsIn(res.body)).toEqual([{ to: "http://localhost/target" }]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("an async component nested in the handler's element names it as well", async () => {
    const { router } = makeRouter();
    const res = await navigate(router, "/throw-nested");

    expect(redirectsIn(res.body)).toEqual([{ to: "http://localhost/target" }]);
  });

  it("an async handler streamed under loading() names the target the same way", async () => {
    const { router } = makeRouter();
    const res = await navigate(router, "/handler-loading");

    expect(res.response.status).toBe(200);
    expect(redirectsIn(res.body)).toEqual([{ to: "http://localhost/target" }]);
  });

  it("so does one that returns redirect() (handleHandlerResult rethrows it)", async () => {
    const { router } = makeRouter();
    const res = await navigate(router, "/handler-loading-return");

    expect(redirectsIn(res.body)).toEqual([{ to: "http://localhost/target" }]);
  });

  it("carries redirect(url, { state }) with the target", async () => {
    const { router } = makeRouter();
    const res = await navigate(router, "/throw-paid");

    expect(redirectsIn(res.body)).toEqual([
      { to: "http://localhost/target", state: { [FLASH]: { text: "paid" } } },
    ]);
  });

  it("drops a state JSON cannot carry and still names the target", async () => {
    const { router } = makeRouter();
    const res = await navigate(router, "/throw-big-state");

    expect(res.response.status).toBe(200);
    expect(redirectsIn(res.body)).toEqual([{ to: "http://localhost/target" }]);
  });

  it("marks an { external: true } target, which the browser leaves the app for", async () => {
    const { router } = makeRouter();
    const res = await navigate(router, "/throw-external");

    expect(redirectsIn(res.body)).toEqual([
      { to: "https://example.com/x", external: true },
    ]);
  });

  it("lands an off-origin target without { external: true } on the app root", async () => {
    const { router } = makeRouter();
    const res = await navigate(router, "/throw-off-origin");

    expect(redirectsIn(res.body)).toEqual([{ to: "/" }]);
  });

  it("prefixes the basename, as redirect() does for a handler", async () => {
    const { router } = makeRouter({ basename: "/app" });
    const res = await navigate(router, "/app/throw-async");

    expect(redirectsIn(res.body)).toEqual([
      { to: "http://localhost/app/target" },
    ]);
  });

  it("leaves an ordinary render error a plain error row, still reported", async () => {
    const { router, onError } = makeRouter();
    const res = await navigate(router, "/boom");

    const digests = errorRowDigests(res.body);
    expect(digests).toHaveLength(1);
    expect(redirectsIn(res.body)).toEqual([undefined]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
