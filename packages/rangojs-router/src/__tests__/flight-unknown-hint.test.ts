/**
 * Pins the React behaviour PREFETCH_FAILED_ROW relies on (#1170): the Flight
 * client skips a hint row (`:H`) whose code it does not know, in its
 * development and production browser builds, and decodes the payload before
 * it unchanged. A React upgrade that dispatches or rejects an unknown hint
 * code fails here, before a failed prefetch's last row reaches a page.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { PREFETCH_FAILED_ROW } from "../prefetch-markers.js";
import "../testing/internal/flight-client-globals.js";

const require = createRequire(import.meta.url);
const VENDOR = "@vitejs/plugin-rsc/vendor/react-server-dom/cjs";

type FlightClient = {
  createFromReadableStream: (
    stream: ReadableStream<Uint8Array>,
    options?: object,
  ) => Promise<unknown>;
};

function load(build: "development" | "production"): FlightClient {
  // The development build exports nothing when NODE_ENV is "production".
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = build;
  try {
    return require(
      `${VENDOR}/react-server-dom-webpack-client.browser.${build}`,
    ) as FlightClient;
  } finally {
    process.env.NODE_ENV = env;
  }
}

function stream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Decode `0:` (a payload whose `later` is a promise of row 1), then `row`,
 * then row 1. A row the client fails on stops the stream and rejects
 * `later`; one it reads as anything but a skipped hint changes the result.
 */
async function decodeAround(client: FlightClient, row: string) {
  const root = (await client.createFromReadableStream(
    stream(`0:{"ok":1,"later":"$@1"}\n${row}1:"value"\n`),
  )) as { ok: number; later: Promise<unknown> };
  return { ok: root.ok, later: await root.later };
}

describe("React's Flight client and an unknown hint code", () => {
  it.each(["development", "production"] as const)(
    "the %s browser build skips the failure row",
    async (build) => {
      const client = load(build);
      expect(await decodeAround(client, PREFETCH_FAILED_ROW)).toEqual({
        ok: 1,
        later: "value",
      });
      const marked = await client.createFromReadableStream(
        stream(`0:{"segments":["a"]}\n${PREFETCH_FAILED_ROW}`),
      );
      expect(marked).toEqual({ segments: ["a"] });
    },
  );

  // A debug row, which a production client refuses, stands in for a row the
  // client fails on.
  it("the check catches a row the client fails on", async () => {
    await expect(
      decodeAround(load("production"), ':D{"time":1}\n'),
    ).rejects.toThrow();
  });

  it("the row is a hint row with a code React does not define", () => {
    expect(PREFETCH_FAILED_ROW).toMatch(/^:H[^DCLmXSM]0\n$/);
  });
});
