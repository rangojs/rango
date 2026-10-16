/**
 * dc-t93: an error that reaches React's server-render shell (no <Suspense>
 * above it) makes renderToReadableStream reject. In production renderHTML
 * answers it instead of rethrowing to the host: a recovery document carrying
 * the same Flight payload (the browser renders it with createRoot), a real
 * 3xx for a loader redirect() with no state, or a static document when there
 * is nothing to recover with. In dev the original error reaches the host
 * (Vite's overlay). Real Fizz (react-dom/server.edge) and the real Flight
 * injector throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { injectRSCPayload } from "rsc-html-stream/server";

vi.mock("../../segment-system.js", () => ({
  renderSegments: vi.fn(() => Promise.resolve(React.createElement("div"))),
}));

import { renderSegments } from "../../segment-system.js";
import { createSSRHandler, type SSRDependencies } from "../index";
import {
  LOADER_REDIRECT,
  loaderResultError,
} from "../../decode-loader-results.js";
import { resolveThemeConfig } from "../../theme/constants.js";

const mockedRenderSegments = vi.mocked(renderSegments);

const FLIGHT_MARKER = "flight-row-marker-7f3a";
const NONCE = "nonce-abc123";

function flightStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`0:"${FLIGHT_MARKER}"\n`));
      controller.close();
    },
  });
}

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function payload(metadata: Record<string, unknown> = {}) {
  return {
    metadata: {
      pathname: "/p",
      params: {},
      matched: ["/p"],
      segments: [],
      ...metadata,
    },
  };
}

function deps(overrides: Partial<SSRDependencies> = {}): SSRDependencies {
  return {
    createFromReadableStream: vi.fn().mockResolvedValue(payload()),
    renderToReadableStream:
      renderToReadableStream as SSRDependencies["renderToReadableStream"],
    injectRSCPayload,
    headScripts: "preinit",
    getClientEntryUrl: () => "/assets/entry.js",
    ...overrides,
  };
}

/** A tree whose only component throws while it renders: a shell error. */
function shellThrows(error: unknown): void {
  function Boom(): never {
    throw error;
  }
  mockedRenderSegments.mockImplementation(() =>
    Promise.resolve(React.createElement(Boom)),
  );
}

function markedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockedRenderSegments.mockReset();
  mockedRenderSegments.mockImplementation(() =>
    Promise.resolve(React.createElement("div")),
  );
});

describe("renderHTML: a shell error in production", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
  });

  it("answers a recovery document with the bootstrap, the nonce and the same Flight payload, as a 500", async () => {
    const error = new Error("loader read outside Suspense");
    shellThrows(error);
    const onError = vi.fn();
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(deps({ onError }));

    const html = await read(
      await renderHTML(flightStream(), { nonce: NONCE, onShellError }),
    );

    expect(html).toContain('<html data-rango-ssr-error="">');
    // Only a browser without JavaScript sees the heading.
    expect(html).toContain(
      "<noscript><h1>Internal Server Error</h1></noscript>",
    );
    expect(html).toContain(
      `<script type="module" src="/assets/entry.js" nonce="${NONCE}"`,
    );
    expect(html).toContain(FLIGHT_MARKER);
    expect(html).toMatch(new RegExp(`<script nonce="${NONCE}">`));
    expect(onShellError).toHaveBeenCalledTimes(1);
    expect(onShellError).toHaveBeenCalledWith({
      error,
      originated: true,
      status: 500,
      location: undefined,
    });
    // The SSR handler's own reporter, once, phase "rendering".
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, { phase: "rendering" });
    // Printed once, by Fizz's onError, as the original error.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(error);
  });

  it("answers a loader's masked rebuild without printing or reporting it again: the loader lane did, with the original", async () => {
    const error = loaderResultError({
      error: {
        message: "An error occurred",
        name: "Error",
        segmentId: "M0L0R1D0.ProductLoader",
        segmentType: "loader",
      },
    });
    shellThrows(error);
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(deps());

    await read(
      await renderHTML(flightStream(), { nonce: NONCE, onShellError }),
    );

    expect(onShellError).toHaveBeenCalledWith({
      error,
      originated: false,
      status: 500,
      location: undefined,
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("answers a loader's notFound() with the recovery document as a 404, and reports and prints nothing", async () => {
    shellThrows(markedError("DataNotFoundError", "missing"));
    const onError = vi.fn();
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(deps({ onError }));

    const html = await read(await renderHTML(flightStream(), { onShellError }));

    expect(html).toContain('<html data-rango-ssr-error="">');
    expect(html).toContain("<h1>Not Found</h1>");
    expect(html).toContain(FLIGHT_MARKER);
    expect(onShellError.mock.calls[0]![0]).toMatchObject({ status: 404 });
    expect(onError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("answers a loader's redirect() without state with a real redirect and no body", async () => {
    const redirect = markedError("LoaderRedirect", "Loader redirected");
    Object.assign(redirect, {
      [LOADER_REDIRECT]: { to: "/target", status: 307 },
    });
    shellThrows(redirect);
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(deps());

    const body = await read(await renderHTML(flightStream(), { onShellError }));

    expect(body).toBe("");
    expect(onShellError).toHaveBeenCalledWith({
      error: redirect,
      originated: false,
      status: 307,
      location: "/target",
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("answers a redirect() with no status as a 302", async () => {
    const redirect = markedError("LoaderRedirect", "Loader redirected");
    Object.assign(redirect, { [LOADER_REDIRECT]: { to: "/target" } });
    shellThrows(redirect);
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(deps());

    await read(await renderHTML(flightStream(), { onShellError }));

    expect(onShellError.mock.calls[0]![0]).toMatchObject({
      status: 302,
      location: "/target",
    });
  });

  it("answers a redirect() with state with the recovery document as a 200: the client replace carries the state", async () => {
    const redirect = markedError("LoaderRedirect", "Loader redirected");
    Object.assign(redirect, {
      [LOADER_REDIRECT]: {
        to: "/target",
        status: 302,
        state: { __rsc_ls_flash: { text: "hi" } },
      },
    });
    shellThrows(redirect);
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(deps());

    const html = await read(await renderHTML(flightStream(), { onShellError }));

    expect(html).toContain('<html data-rango-ssr-error="">');
    expect(html).toContain(FLIGHT_MARKER);
    // 200 like the same redirect inside a <Suspense>: the document, then the
    // client replace.
    expect(onShellError.mock.calls[0]![0]).toMatchObject({
      status: 200,
      location: undefined,
    });
  });

  it("answers a payload that did not decode with a static document: no scripts, nothing from the error", async () => {
    const error = new Error(
      "root payload failed at /srv/app/dist/rsc/index.js",
    );
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(
      deps({ createFromReadableStream: vi.fn().mockRejectedValue(error) }),
    );

    const html = await read(
      await renderHTML(flightStream(), { nonce: NONCE, onShellError }),
    );

    expect(html).toBe(
      '<!DOCTYPE html><html data-rango-ssr-error=""><head><meta charset="utf-8"/>' +
        "<title>Internal Server Error</title></head><body><h1>Internal Server Error</h1></body></html>",
    );
    expect(onShellError).toHaveBeenCalledWith({
      error,
      originated: false,
      status: 500,
      location: undefined,
    });
    // Fizz never saw it: renderHTML prints it, once.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(error);
  });

  it("answers a tree that failed to build with the static document: the browser's build would fail the same way", async () => {
    const error = new Error("tree build failed");
    mockedRenderSegments.mockImplementation(() => Promise.reject(error));
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(deps());

    const html = await read(await renderHTML(flightStream(), { onShellError }));

    expect(html).not.toContain("<script");
    expect(html).not.toContain(FLIGHT_MARKER);
    expect(html).toContain("<h1>Internal Server Error</h1>");
    expect(onShellError).toHaveBeenCalledWith({
      error,
      originated: true,
      status: 500,
      location: undefined,
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(error);
  });

  it("falls back to the static document when the recovery render itself fails", async () => {
    const error = new Error("shell");
    const render = vi.fn().mockRejectedValue(error);
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(
      deps({ renderToReadableStream: render }),
    );

    const html = await read(await renderHTML(flightStream(), { onShellError }));

    expect(render).toHaveBeenCalledTimes(2);
    expect(html).not.toContain("<script");
    expect(onShellError.mock.calls[0]![0]).toMatchObject({ status: 500 });
  });

  it("carries the theme script in the recovery head, with the nonce", async () => {
    const themeConfig = resolveThemeConfig({
      defaultTheme: "light",
      themes: ["light", "dark"],
      attribute: "class",
      storageKey: "theme",
    });
    shellThrows(new Error("shell"));
    const renderHTML = createSSRHandler(
      deps({
        createFromReadableStream: vi
          .fn()
          .mockResolvedValue(payload({ themeConfig })),
      }),
    );

    const html = await read(await renderHTML(flightStream(), { nonce: NONCE }));
    const head = html.slice(0, html.indexOf("</head>"));

    expect(head).toContain(`<script nonce="${NONCE}">`);
    expect(head).toContain("storageKey");
  });
});

describe("renderHTML: a shell error in dev", () => {
  it("rethrows the original error instance to the host, after reporting it once", async () => {
    const error = new Error("loader read outside Suspense");
    shellThrows(error);
    const onError = vi.fn();
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(deps({ onError }));

    const rejection = await renderHTML(flightStream(), {
      onShellError,
    }).catch((e: unknown) => e);

    expect(rejection).toBe(error);
    expect(onShellError).toHaveBeenCalledTimes(1);
    expect(onShellError).toHaveBeenCalledWith({ error, originated: true });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, { phase: "rendering" });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(error);
  });

  it("answers a loader's notFound() as production does: control flow, not an overlay", async () => {
    shellThrows(markedError("DataNotFoundError", "missing"));
    const onShellError = vi.fn();
    const renderHTML = createSSRHandler(deps());

    const html = await read(await renderHTML(flightStream(), { onShellError }));

    expect(html).toContain('<html data-rango-ssr-error="">');
    expect(onShellError.mock.calls[0]![0]).toMatchObject({ status: 404 });
  });
});

// The server prints a failure where it originated, once: a loader's error in
// the loader lane, a server component's in the Flight render. What reaches
// this render is a copy (a loader's masked rebuild, an error Flight decoded),
// so renderHTML prints only what originated here.
describe("renderHTML: what it prints", () => {
  /** A tree with one Suspense boundary whose content throws `error`. */
  function boundaryThrows(error: unknown): void {
    function Boom(): never {
      throw error;
    }
    mockedRenderSegments.mockImplementation(() =>
      Promise.resolve(
        <html>
          <body>
            <React.Suspense fallback={<p>fallback</p>}>
              <Boom />
            </React.Suspense>
          </body>
        </html>,
      ),
    );
  }

  const rebuiltLoaderError = () =>
    loaderResultError({
      error: {
        message: "An error occurred",
        name: "Error",
        segmentId: "M0L0R1D0.ProductLoader",
        segmentType: "loader",
      },
    });
  // What React's Flight client builds for an error row: it sets `digest`.
  const flightCopy = () =>
    Object.assign(
      new Error("An error occurred in the Server Components render."),
      {
        digest: "",
      },
    );

  it.each([
    ["production", "production"],
    ["dev", "development"],
  ])(
    "%s: a loader's rebuilt error or a Flight copy failing the shell prints nothing",
    async (_label, env) => {
      vi.stubEnv("NODE_ENV", env);
      for (const copy of [rebuiltLoaderError(), flightCopy()]) {
        shellThrows(copy);
        const renderHTML = createSSRHandler(deps());
        await renderHTML(flightStream()).then(read, () => undefined);
      }

      expect(consoleError).not.toHaveBeenCalled();
    },
  );

  it("a loader's rebuilt error or a Flight copy inside a Suspense boundary prints nothing", async () => {
    for (const copy of [rebuiltLoaderError(), flightCopy()]) {
      boundaryThrows(copy);
      const renderHTML = createSSRHandler(deps());
      await read(await renderHTML(flightStream()));
    }

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("a boundary the render aborts prints nothing: a cancelled stream, not a failure", async () => {
    boundaryThrows(
      new Error("The render was aborted by the server without a reason."),
    );
    const renderHTML = createSSRHandler(deps());

    await read(await renderHTML(flightStream()));

    expect(consoleError).not.toHaveBeenCalled();
  });

  it("a component that throws only during this render prints its original error once, inside a Suspense boundary too", async () => {
    const error = new Error("reads window");
    boundaryThrows(error);
    const renderHTML = createSSRHandler(deps());

    await read(await renderHTML(flightStream()));

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(error);
  });
});
