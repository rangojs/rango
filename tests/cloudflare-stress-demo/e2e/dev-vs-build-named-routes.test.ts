import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const genFilePath = path.resolve("./src/router.named-routes.gen.ts");

const STATIC_PARSER_LINE =
  /\[rsc-router\] Generated route types \(\d+ routes\) -> /;
const RUNTIME_DISCOVERY_LINE = /\[rsc-router\] Generated route types -> /;

/**
 * Pins the contract that `pnpm dev`'s runtime discovery produces the same
 * `router.named-routes.gen.ts` as `pnpm build`.
 *
 * Pre-fix on the cloudflare-stress-demo, dev startup against a wiped or
 * stale gen file failed two ways:
 *   1. The temp-runner discovery threw `Unknown route: shop.product.item42`
 *      because the user entry calls `router.reverse()` at module load and
 *      `__rscRouterDiscoveryActive` was unset on the dev path (build set it
 *      via router-discovery.ts's build branch but dev didn't).
 *   2. Even after fixing (1), workerd still raced ahead and evaluated
 *      `worker.rsc.tsx` against the 19-route static-parsed gen file because
 *      `import "virtual:rsc-router/routes-manifest"` was source-positioned
 *      after `import "./router.js"`, so the manifest virtual module's
 *      `await s.discoveryDone` gate fired too late.
 *
 * If either regression returns, the dev runtime-discovery log line never
 * fires (or dev exits non-zero) and this test times out / fails. If both
 * fixes hold, the dev gen file matches the build gen file byte-for-byte.
 */
test.describe("dev vs build named-routes parity", () => {
  test("dev runtime discovery produces the same gen file as build", async () => {
    const buildGen = await fs.readFile(genFilePath, "utf-8");
    expect(buildGen.length).toBeGreaterThan(10_000);
    expect(buildGen).toContain('"shop.product.item42":');

    await fs.writeFile(genFilePath, "// dirty marker — dev must regenerate\n");

    let devGen: string | null = null;
    let dev: ChildProcess | null = null;
    let buffer = "";

    try {
      // detached:true makes the child a process-group leader so we can kill
      // the whole tree (pnpm → vite → workerd/miniflare) via
      // process.kill(-pid). Mirrors the existing fixture pattern in
      // packages/rangojs-router/e2e/fixture.ts so we don't leak port 5002
      // when the test ends.
      dev = spawn("pnpm", ["dev"], {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const runtimeDiscoveryComplete = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `dev runtime discovery did not complete within 90s\n` +
                  `--- captured stdout/stderr ---\n${tail(buffer)}`,
              ),
            ),
          90_000,
        );

        // Buffer accumulates raw stdout+stderr. Node stream chunks are NOT
        // line-aligned, so a single chunk can contain both the static-parser
        // line and the later runtime-discovery line — line-by-line scanning
        // over the accumulated buffer is the only way to match reliably.
        const scan = () => {
          // Scan complete lines only; partial trailing line stays buffered.
          const lastNewline = buffer.lastIndexOf("\n");
          if (lastNewline < 0) return;
          const completeRegion = buffer.slice(0, lastNewline + 1);
          // Find static-parser occurrence (if any) and require runtime line
          // to appear after it. The static parser ALWAYS fires first; the
          // runtime-discovery line uses the same prefix without the route
          // count parenthetical.
          const staticMatch = STATIC_PARSER_LINE.exec(completeRegion);
          const searchFrom = staticMatch
            ? staticMatch.index + staticMatch[0].length
            : 0;
          const remainder = completeRegion.slice(searchFrom);
          if (RUNTIME_DISCOVERY_LINE.test(remainder)) {
            clearTimeout(timeout);
            resolve();
          }
        };

        const onData = (chunk: Buffer) => {
          buffer += chunk.toString();
          scan();
        };

        dev!.stdout?.on("data", onData);
        dev!.stderr?.on("data", onData);

        dev!.on("exit", (code, signal) => {
          // Dev should not exit until we kill it. Any spontaneous exit is
          // a regression of the bug this test guards against.
          clearTimeout(timeout);
          if (signal === "SIGTERM" || signal === "SIGKILL") return;
          reject(
            new Error(
              `dev exited unexpectedly (code=${code}, signal=${signal})\n` +
                `--- captured stdout/stderr ---\n${tail(buffer)}`,
            ),
          );
        });
      });

      await runtimeDiscoveryComplete;

      // Tiny grace period for the writer to flush the file. The log line
      // is emitted from inside writeRouteTypesFiles after writeFileSync,
      // so this should be unnecessary in practice — but cheap insurance.
      await new Promise((r) => setTimeout(r, 200));

      devGen = await fs.readFile(genFilePath, "utf-8");
    } finally {
      await killProcessTree(dev);
      // Restore the build gen file so subsequent tests see the expected
      // content even if this test failed mid-flight.
      await fs.writeFile(genFilePath, buildGen);
    }

    expect(
      devGen,
      "dev runtime discovery should have written the gen file",
    ).not.toBeNull();
    expect(
      devGen,
      "dev's gen file must match build's byte-for-byte — drift indicates a discovery path is missing routes",
    ).toBe(buildGen);
  });
});

/**
 * Kill the dev child and its descendants. `pnpm` spawns vite, vite spawns
 * miniflare/workerd; SIGTERM on `pnpm` alone may not propagate, so we
 * target the whole process group via `process.kill(-pid)`. Falls back to
 * direct kill or taskkill on Windows.
 */
async function killProcessTree(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    return;
  }
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  // Grace period for graceful shutdown, then SIGKILL escalation.
  await new Promise((r) => setTimeout(r, 1500));
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function tail(text: string, maxChars = 4000): string {
  if (!text) return "(empty)";
  if (text.length <= maxChars) return text;
  return `...${text.slice(-maxChars)}`;
}
