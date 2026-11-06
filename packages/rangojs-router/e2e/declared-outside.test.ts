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
 * throws where it is written, so the app cannot be built or served: dev route
 * discovery fails and the production build exits 1, both naming the definition
 * and the callback it belongs in.
 *
 * Fixture: test-app/src/urls/dsl-nesting.tsx registers the rejected shape only
 * under RANGO_TEST_DECLARED_OUTSIDE (the app cannot hold it permanently). Both
 * modes run with their own Vite cache dir so neither touches the shared
 * dev/preview servers' optimizer cache.
 */
const cwd = path.resolve("./e2e/test-app");
const VITE = "./node_modules/.bin/vite";
const ERROR = "path() declared outside the layout() it is nested in [";
// Outside every shared server block (5188.. / 5296..), per-checkout offset.
const DEV_PORT = 5393 + checkoutPortOffset();

function isolatedEnv(): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    // Vite exits on stdin EOF unless CI=true (setupSIGTERMListener).
    CI: "true",
    INTERNAL_RANGO_SUSPENSE_AUDIT: "1",
    RANGO_TEST_DECLARED_OUTSIDE: "1",
    RANGO_E2E_VITE_CACHE_DIR: mkdtempSync(
      path.join(tmpdir(), "rango-declared-outside-"),
    ),
  };
}

test.describe("a route declared outside its layout (dev)", () => {
  test.describe.configure({ timeout: 120_000 });

  test("dev discovery fails with the error, and requests fail with it", async ({
    request,
  }) => {
    const child = spawn(VITE, ["--port", String(DEV_PORT), "--strictPort"], {
      cwd,
      detached: true,
      env: isolatedEnv(),
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
        `http://localhost:${DEV_PORT}/dsl-nesting`,
        { headers: { Accept: "text/html" } },
      );
      expect(res.status()).toBe(500);
      await expect
        .poll(() => output.split(ERROR).length - 1, { timeout: 10_000 })
        .toBeGreaterThan(1);
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
  test.describe.configure({ timeout: 180_000 });

  test("the build fails with exit code 1, naming the definition", async () => {
    const res = await x(VITE, ["build", "--outDir", "dist-declared-outside"], {
      nodeOptions: { cwd, env: isolatedEnv() },
      throwOnError: false,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    expect(res.exitCode, `build should exit 1; output:\n${out}`).toBe(1);
    expect(out).toContain(ERROR);
  });
});
