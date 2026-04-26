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

  test("HMR rediscovery preserves the full gen file (cold → touch → second runtime write)", async ({}, testInfo) => {
    // Two consecutive runtime-discovery cycles + dev cold start is ~3-5s of
    // wall-clock work; bump the per-test timeout above playwright's 60s
    // default so the wait-for-write timeouts don't trip first.
    testInfo.setTimeout(120_000);
    const buildGen = await fs.readFile(genFilePath, "utf-8");
    expect(buildGen.length).toBeGreaterThan(10_000);

    let dev: ChildProcess | null = null;
    let buffer = "";
    // Count `[rsc-router] Router "X" -> N routes (...)` log lines — fired
    // unconditionally by discoverRouters() once per cycle, so the count is
    // a reliable signal of "runtime discovery completed" across both cold
    // start and HMR. (The "Generated route types -> " write log only fires
    // when the gen file's bytes change, and HMR rediscovery writes
    // identical bytes when routes haven't actually changed.)
    let discoveryCount = 0;
    const discoveryWaiters: Array<{
      target: number;
      resolve: () => void;
      reject: (e: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }> = [];

    const waitForDiscoveries = (n: number, label: string) =>
      new Promise<void>((resolve, reject) => {
        if (discoveryCount >= n) return resolve();
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for runtime discovery #${n} (${label}); ` +
                `seen=${discoveryCount}\n--- captured ---\n${tail(buffer)}`,
            ),
          );
        }, 90_000);
        discoveryWaiters.push({ target: n, resolve, reject, timeout });
      });

    try {
      await fs.writeFile(
        genFilePath,
        "// dirty marker — dev must regenerate\n",
      );

      dev = spawn("pnpm", ["dev"], {
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lastNewline = buffer.lastIndexOf("\n");
        if (lastNewline < 0) return;
        // Scan complete-line region only (chunk-safe — see fixture pattern
        // notes). Count occurrences of the per-router discovery summary log
        // line that discoverRouters() emits unconditionally on every cycle.
        const completeRegion = buffer.slice(0, lastNewline + 1);
        const matches =
          completeRegion.match(
            /\[rsc-router\] Router "[^"]+" -> \d+ routes/g,
          ) ?? [];
        const newCount = matches.length;
        if (newCount > discoveryCount) {
          discoveryCount = newCount;
          for (const w of discoveryWaiters.slice()) {
            if (discoveryCount >= w.target) {
              clearTimeout(w.timeout);
              w.resolve();
              discoveryWaiters.splice(discoveryWaiters.indexOf(w), 1);
            }
          }
        }
      };
      dev.stdout?.on("data", onData);
      dev.stderr?.on("data", onData);

      let unexpectedExit: Error | null = null;
      dev.on("exit", (code, signal) => {
        if (signal === "SIGTERM" || signal === "SIGKILL") return;
        unexpectedExit = new Error(
          `dev exited unexpectedly (code=${code}, signal=${signal})\n` +
            `--- captured ---\n${tail(buffer)}`,
        );
        for (const w of discoveryWaiters.slice()) {
          clearTimeout(w.timeout);
          w.reject(unexpectedExit);
        }
        discoveryWaiters.length = 0;
      });

      // 1. Cold-start runtime discovery completes.
      await waitForDiscoveries(1, "cold-start");
      // Settling pause: cold-start triggers workerd reloads (the manifest
      // virtual module change cascades through). Touching too early races
      // against that fan-out and chokidar can drop the watcher event.
      // 2.5s covers the observed ~2.5s "VITE ready" milestone.
      await new Promise((r) => setTimeout(r, 2500));
      const coldGen = await fs.readFile(genFilePath, "utf-8");
      expect(coldGen).toBe(buildGen);

      // 2. Trigger HMR by appending a no-op whitespace edit to a route
      //    source file. Vite/chokidar normalizes some file-system events,
      //    so a tiny content change is the most reliable cross-platform way
      //    to fire a `change` event without altering parsed route output.
      const sourceFile = path.resolve("./src/shop-patterns.tsx");
      const sourceContent = await fs.readFile(sourceFile, "utf-8");
      const restoreOriginal = async () => {
        await fs.writeFile(sourceFile, sourceContent);
      };
      try {
        await fs.writeFile(sourceFile, sourceContent + "\n");

        // 3. Second runtime discovery completes (HMR rediscovery via temp runner).
        await waitForDiscoveries(2, "post-HMR");
        await new Promise((r) => setTimeout(r, 200));

        // 4. Process must still be alive — pre-fix, workerd would have hit
        //    `Unknown route: shop.product.item42` against a partial 19-route
        //    gen file written by the static parser and exited.
        expect(
          unexpectedExit,
          "dev exited during HMR rediscovery — gen file likely shrank and workerd crashed",
        ).toBeNull();
        expect(dev.exitCode).toBeNull();

        // 5. Gen file matches build byte-for-byte AFTER HMR.
        const postHmrGen = await fs.readFile(genFilePath, "utf-8");
        expect(
          postHmrGen,
          "dev's gen file after HMR must still match build — runtime rediscovery should restore factory routes",
        ).toBe(buildGen);
      } finally {
        // Always restore the source file even if assertions failed.
        await restoreOriginal();
      }
    } finally {
      await killProcessTree(dev);
      await fs.writeFile(genFilePath, buildGen);
    }
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
