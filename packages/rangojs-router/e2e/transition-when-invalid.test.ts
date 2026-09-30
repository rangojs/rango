import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { checkoutPortOffset } from "@shared/e2e";
import { x } from "tinyexec";

/**
 * An invalid transition({ when }) is a LOUD definition error. `when` runs in
 * the browser, so in urls() it must be a "use client" export; a plain (server)
 * function fails route discovery. The fixture (e2e/prerender-onerror, a
 * dedicated projectRoot with its own dist/) registers
 * `/server-when/:id` with a server `when` only under RANGO_TEST_SERVER_WHEN.
 *
 * - dev: startup discovery prints the error naming the route, and requests
 *   fail with it (the runtime rebuild validates too) instead of serving the
 *   app silently or hitting React's generic "Functions cannot be passed";
 * - production: the build fails (exit 1) with the same error.
 *
 * The HMR overlay case lives in route-types-hmr.test.ts (dev-only).
 */
const cwd = path.resolve("./e2e/prerender-onerror");
const VITE = "./node_modules/.bin/vite";
const ERROR =
  "transition({ when }) on route /server-when/:id is not a client function.";
// Outside every shared server block (5188.. / 5296..), per-checkout offset.
const DEV_PORT = 5391 + checkoutPortOffset();

test.describe("transition-when invalid definition (dev)", () => {
  test.describe.configure({ timeout: 120_000 });

  test("dev startup fails route discovery with the error, and requests fail with it", async ({
    request,
  }) => {
    const child = spawn(VITE, ["--port", String(DEV_PORT), "--strictPort"], {
      cwd,
      detached: true,
      // Vite exits on stdin EOF unless CI=true (setupSIGTERMListener).
      env: { ...process.env, CI: "true", RANGO_TEST_SERVER_WHEN: "1" },
    });
    let output = "";
    const collect = (data: Buffer) => {
      output += stripVTControlCharacters(String(data));
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    try {
      await expect
        .poll(() => output, { timeout: 60_000 })
        .toContain("Router discovery failed");
      expect(output).toContain(ERROR);

      const res = await request.get(
        `http://localhost:${DEV_PORT}/server-when/1`,
        { headers: { Accept: "text/html" } },
      );
      expect(res.status()).toBe(500);
      await expect
        .poll(() => output.split(ERROR).length - 1, { timeout: 10_000 })
        .toBeGreaterThan(1);
      expect(output).not.toContain(
        "Functions cannot be passed directly to Client Components",
      );
    } finally {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill();
      }
    }
  });
});

test.describe("transition-when invalid definition (production)", () => {
  test.describe.configure({ timeout: 180_000 });

  test("the build fails with exit code 1, naming the route", async () => {
    const res = await x(VITE, ["build"], {
      nodeOptions: {
        cwd,
        env: { ...process.env, RANGO_TEST_SERVER_WHEN: "1" } as Record<
          string,
          string
        >,
      },
      throwOnError: false,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    expect(res.exitCode, `build should exit 1; output:\n${out}`).toBe(1);
    expect(out).toContain(ERROR);
  });
});
