import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// The public entry, so these tests also pin what a consumer's own fixture can
// import from `@rangojs/router/testing/e2e`.
import {
  createIsolatedViteCacheDir,
  waitForReady,
  warmupDevServer,
} from "../e2e/index.js";

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
  });
  server = undefined;
});

/**
 * A local server that answers each request with the next status in
 * `statuses` (the last one repeats), recording each request's Accept header.
 */
async function serve(statuses: number[]): Promise<{
  url: string;
  accepts: Array<string | undefined>;
}> {
  const accepts: Array<string | undefined> = [];
  server = createServer((req, res) => {
    const status = statuses[Math.min(accepts.length, statuses.length - 1)]!;
    accepts.push(req.headers.accept);
    res.writeHead(status).end("ok");
  });
  await new Promise<void>((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, accepts };
}

describe("waitForReady", () => {
  it("resolves once the URL answers 2xx, polling through errors", async () => {
    const { url, accepts } = await serve([503, 500, 200]);
    await waitForReady(url, undefined, 5_000);
    expect(accepts).toHaveLength(3);
  });

  it("throws after the timeout with the URL and the tail of the output", async () => {
    const { url } = await serve([503]);
    const error = await waitForReady(
      url,
      () => ({ stdout: "vite ready", stderr: "boom: missing module" }),
      300,
    ).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain(`Server not ready after 300ms: ${url}`);
    expect(error?.message).toContain("Recent stdout:\nvite ready");
    expect(error?.message).toContain("Recent stderr:\nboom: missing module");
  });
});

describe("warmupDevServer", () => {
  it("returns after two consecutive document responses", async () => {
    const { url, accepts } = await serve([200]);
    await warmupDevServer(url);
    expect(accepts).toEqual(["text/html", "text/html"]);
  });

  it("starts the count again after a failed response", async () => {
    const { url, accepts } = await serve([200, 500, 200]);
    await warmupDevServer(url);
    expect(accepts).toHaveLength(4);
  }, 10_000);
});

describe("createIsolatedViteCacheDir", () => {
  it("gives each call its own directory under <cwd>/.vite-isolated", () => {
    const cwd = path.resolve("/app");
    const first = createIsolatedViteCacheDir(cwd, "chromium (prod)", "build");
    const second = createIsolatedViteCacheDir(cwd, "chromium (prod)", "build");
    expect(path.dirname(first)).toBe(path.join(cwd, ".vite-isolated"));
    expect(path.basename(first)).toMatch(
      /^chromium--prod--build-\d+-[a-z0-9]+$/,
    );
    expect(second).not.toBe(first);
  });

  it("names a server with no mode", () => {
    const dir = createIsolatedViteCacheDir("/app", "dev", undefined);
    expect(path.basename(dir)).toMatch(/^dev-server-/);
  });
});
