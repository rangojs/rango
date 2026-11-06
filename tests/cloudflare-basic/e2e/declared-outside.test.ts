import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { checkoutPortOffset } from "@shared/e2e";
import { x } from "tinyexec";

/**
 * A route declared above the layout() that nests it used to render at the root
 * with the layout silently gone and the request still answering 200. It now
 * throws where it is written, so the app cannot be served or built: dev route
 * discovery fails and the production build exits 1, both naming the definition
 * and the callback it belongs in. workerd mirror of the router package's
 * e2e/declared-outside.test.ts.
 *
 * Fixture: src/pages/dsl-nesting.tsx registers the rejected shape only under
 * RANGO_TEST_DECLARED_OUTSIDE (inlined by vite.config.ts, since workerd's
 * process.env is not the host's). Both modes run with their own Vite cache dir
 * so neither touches the shared dev/preview servers.
 */
const cwd = path.resolve(".");
const VITE = "./node_modules/.bin/vite";
const ERROR = "path() declared outside the layout() it is nested in [";
// Outside the shared 5198/5199 block, per-checkout offset.
const DEV_PORT = 5394 + checkoutPortOffset();

function isolatedEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    INTERNAL_RANGO_SUSPENSE_AUDIT: "1",
    RANGO_TEST_DECLARED_OUTSIDE: "1",
    RANGO_E2E_VITE_CACHE_DIR: mkdtempSync(
      path.join(tmpdir(), "rango-cf-declared-outside-"),
    ),
  };
}

test.describe("a route declared outside its layout (dev)", () => {
  test.describe.configure({ timeout: 180_000 });

  test("dev discovery fails with the error, and requests fail with it", async ({
    request,
  }) => {
    const child = spawn(
      VITE,
      ["dev", "--port", String(DEV_PORT), "--strictPort"],
      { cwd, detached: true, env: isolatedEnv() },
    );
    let output = "";
    const collect = (data: Buffer) => {
      output += stripVTControlCharacters(String(data));
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    try {
      await expect
        .poll(() => output, { timeout: 120_000 })
        .toContain("Router discovery failed");
      expect(output).toContain(ERROR);

      // The CF plugin binds the port after the first discovery pass, so poll
      // until the server answers rather than assuming it is listening.
      const url = `http://localhost:${DEV_PORT}/dsl-nesting`;
      await expect
        .poll(
          async () => {
            try {
              return (
                await request.get(url, {
                  headers: { Accept: "text/html" },
                })
              ).status();
            } catch {
              return 0;
            }
          },
          { timeout: 120_000 },
        )
        .toBe(500);
      expect(
        await (
          await request.get(url, { headers: { Accept: "text/html" } })
        ).text(),
      ).toContain(ERROR);
    } finally {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  });
});

test.describe("a route declared outside its layout (production)", () => {
  test.describe.configure({ timeout: 300_000 });

  test("the build fails with exit code 1, naming the definition", async () => {
    // The build dies in route discovery, before the Cloudflare plugin writes
    // dist/, so the preview server's output is untouched (asserted below).
    const res = await x(VITE, ["build"], {
      nodeOptions: { cwd, env: isolatedEnv() },
      throwOnError: false,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    expect(res.exitCode, `build should exit 1; output:\n${out}`).toBe(1);
    expect(out).toContain(ERROR);
  });
});
