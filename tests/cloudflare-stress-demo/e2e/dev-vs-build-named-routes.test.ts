import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const genFilePath = path.resolve("./src/router.named-routes.gen.ts");

const STATIC_PARSER_LINE = /\[rango\] Generated route types \(\d+ routes\) -> /;
const RUNTIME_DISCOVERY_LINE = /\[rango\] Generated route types -> /;

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
    // Count `[rango] Router "X" -> N routes (...)` log lines — fired
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
          completeRegion.match(/\[rango\] Router "[^"]+" -> \d+ routes/g) ?? [];
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

  test("rapid duplicate route-file events don't orphan the discovery gate", async ({}, testInfo) => {
    // Two-shot regression test for the gate-state bugs the reviewer flagged:
    //
    //   1. beginDiscoveryGate() must reuse an already-pending gate. File
    //      watchers can fire multiple events for a single save (atomic-save
    //      flows, polling on CI) and workerd may already be awaiting the
    //      previous promise. If we replace the resolver, the original promise
    //      becomes un-resolvable and workerd's manifest load() hangs.
    //
    //   2. The runtimeRediscoveryInProgress early-return must not orphan a
    //      newly-created gate. If a second route-file event arrives mid-
    //      rediscovery, handleRouteFileChange resets the gate AGAIN — and the
    //      pre-fix early-return path resolved nothing. The fix queues a
    //      follow-up cycle and resolves the gate only at the tail.
    //
    // The test triggers two source edits with a delay tuned to land the
    // second event during the first rediscovery's in-flight window
    // (rediscovery is ~700ms, debounce is 100ms, so 200ms between touches
    // keeps the second one inside the first cycle's work). Pre-fix, this
    // hangs dev's gen file or leaves workerd stuck on the manifest load.
    testInfo.setTimeout(120_000);
    const buildGen = await fs.readFile(genFilePath, "utf-8");

    let dev: ChildProcess | null = null;
    let buffer = "";
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
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for runtime discovery #${n} (${label}); ` +
                  `seen=${discoveryCount}\n--- captured ---\n${tail(buffer)}`,
              ),
            ),
          90_000,
        );
        discoveryWaiters.push({ target: n, resolve, reject, timeout });
      });

    try {
      await fs.writeFile(genFilePath, "// dirty marker\n");

      dev = spawn("pnpm", ["dev"], {
        cwd: process.cwd(),
        // DEBUG=rango:discovery surfaces the "consuming queued rediscovery"
        // log line that proves the queue path actually ran.
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          DEBUG: "rango:discovery",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lastNewline = buffer.lastIndexOf("\n");
        if (lastNewline < 0) return;
        const completeRegion = buffer.slice(0, lastNewline + 1);
        const matches =
          completeRegion.match(/\[rango\] Router "[^"]+" -> \d+ routes/g) ?? [];
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

      await waitForDiscoveries(1, "cold-start");
      await new Promise((r) => setTimeout(r, 2500));

      const sourceFile = path.resolve("./src/shop-patterns.tsx");
      const sourceContent = await fs.readFile(sourceFile, "utf-8");
      const restoreOriginal = async () => {
        await fs.writeFile(sourceFile, sourceContent);
      };
      try {
        // Capture buffer offset BEFORE the HMR edits so subsequent
        // waitForLog calls don't match cold-start log lines (the
        // "discoveryDone resolved" line fires once on cold-start too —
        // without an offset, the trailing assertion would match
        // immediately and not actually pin the post-HMR resolution).
        const preHmrIdx = buffer.length;

        // First edit: triggers refresh A. Whitespace-only is fine here —
        // we just need the watcher to fire so refresh A starts. The
        // route-meaningful edit goes into touch 2 below so we can prove
        // refresh B actually rewrote the manifest.
        await fs.writeFile(sourceFile, sourceContent + "\n");

        // Wait until refresh A's temp-server reload has STARTED — that
        // log fires after the 100ms debounce and at the very beginning of
        // the work phase. From here we know runtimeRediscoveryInProgress
        // is true, so the second edit is guaranteed to land in the
        // queued path.
        await waitForLogFromIdx(
          () => buffer,
          /refreshTempRscEnv: invalidating module graph/,
          "refresh A in-flight",
          preHmrIdx,
        );

        // Second edit: route-meaningful. Bumping the factory's `length`
        // adds a NEW route (`shop.product.item101`) so refresh B's gen
        // output differs from refresh A's. If refresh B failed to run or
        // wrote against the old source, the gen file would not include
        // the new route and the assertion below would catch it.
        const editedContent = sourceContent.replace(
          /Array\.from\(\{ length: 100 \}/,
          "Array.from({ length: 101 }",
        );
        if (editedContent === sourceContent) {
          throw new Error(
            "test fixture invariant broken: shop-patterns.tsx must contain `Array.from({ length: 100 }`",
          );
        }
        await fs.writeFile(sourceFile, editedContent);

        // Wait for the queue path to actually fire. Anchored on the
        // post-HMR offset so cold-start log lines can't satisfy the wait.
        await waitForLogFromIdx(
          () => buffer,
          /hmr: rediscovery in flight — queued for a follow-up cycle/,
          "queue marker",
          preHmrIdx,
        );
        await waitForLogFromIdx(
          () => buffer,
          /hmr: consuming queued rediscovery/,
          "queue consumed",
          preHmrIdx,
        );

        // Three discoveries total: cold + refresh A + queued refresh.
        await waitForDiscoveries(3, "post-rapid-edits");

        // Anchor on the gen-file content directly. Refresh A's gate
        // resolution can race with chokidar latency (touch 2's handler
        // sometimes fires before, sometimes after refresh A's finally
        // depending on timing), so waiting on log lines for "second
        // gate resolved" is platform-fragile. Polling the file for the
        // new route is a direct check of "refresh B ran and wrote it."
        await waitForGenFileContains(
          genFilePath,
          '"shop.product.item101":',
          "post-rapid-edits: queued refresh writes new factory route",
          () => buffer,
        );

        expect(
          unexpectedExit,
          "dev exited during rapid-event rediscovery — gate likely orphaned",
        ).toBeNull();

        const postGen = await fs.readFile(genFilePath, "utf-8");
        expect(
          postGen,
          "post-HMR gen must still include all original routes — refresh B should not have lost any",
        ).toContain('"shop.product.item42":');
      } finally {
        await restoreOriginal();
      }
    } finally {
      await killProcessTree(dev);
      await fs.writeFile(genFilePath, buildGen);
    }
  });

  test("rapid edits near refresh tail keep gen file consistent", async ({}, testInfo) => {
    // Regression test for the tail-race window flagged in code review:
    // an event arriving in refresh A's tail (after writeRouteTypesFiles)
    // whose debounce fires AFTER A's finally would, pre-fix, leave the
    // gate resolved while refresh B was still inbound — the workerd
    // window between A's resolve and B's start could read stale gen.
    //
    // Fix: handleRouteFileChange sets `pendingRouteEvents` at event time;
    // refresh's finally holds the gate pending if the flag is set even
    // when nothing is queued.
    //
    // The exact timing window is hard to hit reliably across platforms
    // (chokidar latency varies ~50–200ms on macOS/Linux/CI), so this
    // test focuses on the user-visible contract: dev stays alive across
    // a touch right at the refresh tail, and the gen file ends up
    // matching build. The internal `pendingRouteEvents` path is exercised
    // probabilistically depending on chokidar timing, and the fix is
    // verified by code reasoning (held gate vs prematurely resolved
    // gate) plus the queue-path test above which proves
    // beginDiscoveryGate idempotency.
    testInfo.setTimeout(120_000);
    const buildGen = await fs.readFile(genFilePath, "utf-8");

    let dev: ChildProcess | null = null;
    let buffer = "";
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
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for runtime discovery #${n} (${label}); ` +
                  `seen=${discoveryCount}\n--- captured ---\n${tail(buffer)}`,
              ),
            ),
          90_000,
        );
        discoveryWaiters.push({ target: n, resolve, reject, timeout });
      });

    try {
      await fs.writeFile(genFilePath, "// dirty marker\n");
      dev = spawn("pnpm", ["dev"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          DEBUG: "rango:discovery",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lastNewline = buffer.lastIndexOf("\n");
        if (lastNewline < 0) return;
        const completeRegion = buffer.slice(0, lastNewline + 1);
        const matches =
          completeRegion.match(/\[rango\] Router "[^"]+" -> \d+ routes/g) ?? [];
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

      await waitForDiscoveries(1, "cold-start");
      await new Promise((r) => setTimeout(r, 2500));

      const sourceFile = path.resolve("./src/shop-patterns.tsx");
      const sourceContent = await fs.readFile(sourceFile, "utf-8");
      const restoreOriginal = async () => {
        await fs.writeFile(sourceFile, sourceContent);
      };

      try {
        // Capture buffer offset BEFORE the HMR edits. All
        // waitForLogFromIdx calls below use this offset so cold-start
        // log lines (`Generated route types -> `, `discoveryDone
        // resolved`, etc.) can't satisfy the wait — without it, the
        // trailing assertion on `discoveryDone resolved` would match
        // the cold-start emission immediately and fail to pin the
        // post-HMR resolution.
        const preHmrIdx = buffer.length;

        // First edit: whitespace-only triggers refresh A. Route-meaningful
        // edit is reserved for touch 2 below so we can prove refresh B
        // actually rewrote the manifest.
        await fs.writeFile(sourceFile, sourceContent + "\n");

        // Wait for refresh A to reach its WRITE step — the last sync
        // step in the work phase. After this, refresh A's finally runs
        // synchronously. Touch 2 must arrive AFTER this point but BEFORE
        // its 100ms debounce expires (so the new debounce fires AFTER
        // refresh A's finally — the tail-race window pre-fix).
        await waitForLogFromIdx(
          () => buffer,
          /hmr writeRouteTypesFiles/,
          "refresh A near tail",
          preHmrIdx,
        );

        // Touch 2: route-meaningful, immediately after writeRouteTypesFiles.
        // Bumping `length` adds `shop.product.item101`. If pre-fix the
        // gate resolved between A's finally and B's start, workerd could
        // observe stale gen — but more importantly, the END-STATE gen
        // file must include the new route, proving refresh B ran with
        // the new source. (The whitespace-only earlier version of this
        // test couldn't distinguish stale-A from fresh-B because their
        // manifest output was identical — review feedback.)
        const editedContent = sourceContent.replace(
          /Array\.from\(\{ length: 100 \}/,
          "Array.from({ length: 101 }",
        );
        if (editedContent === sourceContent) {
          throw new Error(
            "test fixture invariant broken: shop-patterns.tsx must contain `Array.from({ length: 100 }`",
          );
        }
        await fs.writeFile(sourceFile, editedContent);

        // Refresh B runs (debounce expires, possibly after refresh A's
        // finally) and resolves the gate. Path is non-deterministic by
        // platform (queue vs pendingRouteEvents depending on chokidar
        // latency); the user-visible contract — dev alive, gen reflects
        // the new edit — is what we pin.
        //
        // Anchoring on the gen-file content directly (rather than
        // log-line ordering) is the most robust signal:
        //
        //   - Refresh A's `discoveryDone resolved` log fires when the
        //     gate is released for refresh A's output. With chokidar
        //     latency on macOS/CI, touch 2's `handleRouteFileChange`
        //     can run AFTER refresh A's finally, so pendingRouteEvents
        //     wasn't set in time and refresh A's gate resolves
        //     normally. This is fine — the touch then creates a fresh
        //     gate2 that workerd's later reload awaits. The test's
        //     job is to verify END STATE, not internal log ordering.
        //
        //   - Polling the gen file until it contains the new route is
        //     a direct check of "refresh B ran and wrote correctly."
        //     If it never appears, the test times out with a clear
        //     diagnostic (full dev buffer dumped on failure).
        await waitForDiscoveries(3, "post-tail-race");
        await waitForGenFileContains(
          genFilePath,
          '"shop.product.item101":',
          "post-tail-race: refresh B writes new factory route",
          () => buffer,
        );

        expect(
          unexpectedExit,
          "dev exited during tail-race — gate likely resolved against stale gen",
        ).toBeNull();

        const postGen = await fs.readFile(genFilePath, "utf-8");
        expect(
          postGen,
          "post-tail-race gen must still include all original routes",
        ).toContain('"shop.product.item42":');
      } finally {
        await restoreOriginal();
      }
    } finally {
      await killProcessTree(dev);
      await fs.writeFile(genFilePath, buildGen);
    }
  });

  test("HMR remove factory route — invalidation drops it from gen", async ({}, testInfo) => {
    // Module-graph invalidation must drop entries that no longer exist in
    // the source, not just ADD new ones. Bump factory `length: 100 → 101`
    // first (to introduce item101), then back to `length: 100` (item101
    // must disappear). If invalidation is incomplete and the runner
    // serves cached source, the post-remove gen file would still contain
    // item101 and this test would fail.
    testInfo.setTimeout(120_000);
    const buildGen = await fs.readFile(genFilePath, "utf-8");

    const dev = await runDevAndWaitForRediscovery(buildGen);
    try {
      const sourceFile = path.resolve("./src/shop-patterns.tsx");
      const sourceContent = await fs.readFile(sourceFile, "utf-8");
      try {
        // Step 1: add item101 by bumping length.
        const withExtra = sourceContent.replace(
          /Array\.from\(\{ length: 100 \}/,
          "Array.from({ length: 101 }",
        );
        if (withExtra === sourceContent) {
          throw new Error(
            "fixture invariant: shop-patterns.tsx must contain `Array.from({ length: 100 }`",
          );
        }
        await fs.writeFile(sourceFile, withExtra);
        await waitForGenFileContains(
          genFilePath,
          '"shop.product.item101":',
          "add: item101 should appear",
          () => dev.buffer,
        );

        // Step 2: remove item101 by reverting length.
        await fs.writeFile(sourceFile, sourceContent);
        await waitForGenFileMissing(
          genFilePath,
          '"shop.product.item101":',
          "remove: item101 should disappear after invalidation",
          () => dev.buffer,
        );

        const postGen = await fs.readFile(genFilePath, "utf-8");
        expect(
          postGen,
          "post-remove gen must still include the unaffected route — invalidation should not be too aggressive",
        ).toContain('"shop.product.item42":');
        expect(
          dev.unexpectedExit,
          "dev must stay alive across remove",
        ).toBeNull();

        // Lifecycle proof: clearTempRegistries must run between
        // module-graph invalidation and re-import. Without it, a
        // hypothetical edit that removed an entire createRouter() call
        // (or changed the router id) would leave the OLD router in
        // RouterRegistry alongside the new — discoverRouters would emit
        // ghost routes. cf-stress only has one router so this exact
        // scenario isn't directly covered, but asserting the log line
        // guarantees the lifecycle code path is wired and would handle
        // the multi-router / id-change case.
        expect(
          dev.buffer,
          "refresh must clear RouterRegistry/HostRouterRegistry singletons that survive moduleGraph.invalidateAll()",
        ).toMatch(
          /clearTempRegistries: cleared RouterRegistry \+ HostRouterRegistry/,
        );
      } finally {
        await fs.writeFile(sourceFile, sourceContent);
      }
    } finally {
      await killProcessTree(dev.proc);
      await fs.writeFile(genFilePath, buildGen);
    }
  });

  test("HMR rename factory route — old names disappear, new appear", async ({}, testInfo) => {
    // Rename `name: \`item${i + 1}\`` → `name: \`product${i + 1}\``.
    // Pre-fix module-graph staleness would either (a) keep both old and
    // new names (additive — runner saw both versions) or (b) keep only
    // old (no update). Post-fix: old gone, new present.
    testInfo.setTimeout(120_000);
    const buildGen = await fs.readFile(genFilePath, "utf-8");

    const dev = await runDevAndWaitForRediscovery(buildGen);
    try {
      const sourceFile = path.resolve("./src/shop-patterns.tsx");
      const sourceContent = await fs.readFile(sourceFile, "utf-8");
      try {
        const renamed = sourceContent.replace(
          /name: `item\$\{i \+ 1\}`/,
          "name: `product${i + 1}`",
        );
        if (renamed === sourceContent) {
          throw new Error(
            "fixture invariant: shop-patterns.tsx must contain ``name: `item${i + 1}` ``",
          );
        }
        await fs.writeFile(sourceFile, renamed);

        // New name must appear.
        await waitForGenFileContains(
          genFilePath,
          '"shop.product.product1":',
          "rename: new name `product1` should appear",
          () => dev.buffer,
        );

        // Old name must disappear.
        await waitForGenFileMissing(
          genFilePath,
          '"shop.product.item42":',
          "rename: old name `item42` should disappear after invalidation",
          () => dev.buffer,
        );

        expect(
          dev.unexpectedExit,
          "dev must stay alive across rename",
        ).toBeNull();
      } finally {
        await fs.writeFile(sourceFile, sourceContent);
      }
    } finally {
      await killProcessTree(dev.proc);
      await fs.writeFile(genFilePath, buildGen);
    }
  });

  test("first urls.tsx edit after cold start does NOT log `transport was disconnected`", async ({}, testInfo) => {
    // Before module-graph invalidation: closing+recreating the temp Vite
    // server during workerd's first post-cold-start module-fetch window
    // disrupted the main dev server's transport, surfacing a
    // `transport was disconnected, cannot call "fetchModule"` error
    // (workerd's eval was in flight at /router/manifest.ts:9 when our
    // close() happened). With invalidateAll, the same Vite instance stays
    // alive and the transport is undisturbed.
    //
    // urls.tsx is the right target because it's high in the import graph
    // → vite issues a full reload of worker-entry → workerd's cold cache
    // is what gets exercised.
    testInfo.setTimeout(120_000);
    const buildGen = await fs.readFile(genFilePath, "utf-8");

    const dev = await runDevAndWaitForRediscovery(buildGen);
    try {
      const sourceFile = path.resolve("./src/urls.tsx");
      const sourceContent = await fs.readFile(sourceFile, "utf-8");
      try {
        const preEditIdx = dev.buffer.length;
        // Whitespace-only edit is fine — we're testing the transport
        // window, not route correctness.
        await fs.writeFile(sourceFile, sourceContent + "\n");

        // Wait for the HMR cycle to complete via the discoveryDone log.
        await waitForLogFromIdx(
          () => dev.buffer,
          /hmr: discoveryDone resolved/,
          "post-urls-edit gate resolution",
          preEditIdx,
        );

        const postEditSlice = dev.buffer.slice(preEditIdx);
        expect(
          postEditSlice,
          "first urls.tsx edit must not surface a transport-disconnect error",
        ).not.toMatch(/transport was disconnected/);
        // Also verify our invalidation path actually fired (vs the close
        // +recreate fallback). If invalidate was unavailable on this
        // Vite version, this test would still pass via the fallback —
        // and the assertion above would still be the user-visible
        // contract — so we don't fail when the fallback path is used,
        // but we DO log it for diagnosability.
        if (
          !/refreshTempRscEnv: invalidating module graph/.test(postEditSlice)
        ) {
          // eslint-disable-next-line no-console
          console.warn(
            "[test] refreshTempRscEnv took the close+recreate fallback path — verify Vite's moduleGraph.invalidateAll API hasn't moved",
          );
        }
        expect(dev.unexpectedExit).toBeNull();
      } finally {
        await fs.writeFile(sourceFile, sourceContent);
      }
    } finally {
      await killProcessTree(dev.proc);
      await fs.writeFile(genFilePath, buildGen);
    }
  });

  test("single source edit produces exactly one HMR rediscovery cycle", async ({}, testInfo) => {
    // Regression: prior to the hotUpdate suppression, every HMR cycle ran TWICE
    // — once from the user's source edit, and again from vite's chokidar
    // detecting our subsequent gen-file write (writeRouteTypesFiles after
    // refreshTempRscEnv). The duplicate cycle was harmless but visible to users
    // as a duplicate "HMR: version changed" event on the client.
    //
    // Our hotUpdate hook returns [] for paths in selfWrittenGenFiles, dropping
    // the cascade. This test asserts ONE HMR cycle per edit.
    //
    // We count the router's own per-cycle marker (`hmr re-discovery done`)
    // rather than a vite-native reload log. Vite 7 emitted `[vite] program
    // reload`; Vite 8 (Rolldown) instead does a granular `[vite] (rsc) hmr
    // update`, which is colorized AND is not reliably captured in the CI dev
    // buffer (and the server-side "version updated" bump count differs between
    // local and CI). `hmr re-discovery done` fires exactly once per HMR cycle in
    // both environments, so a duplicate cascade would still surface as count 2.
    testInfo.setTimeout(120_000);
    const buildGen = await fs.readFile(genFilePath, "utf-8");

    const dev = await runDevAndWaitForRediscovery(buildGen);
    try {
      const sourceFile = path.resolve("./src/urls.tsx");
      const sourceContent = await fs.readFile(sourceFile, "utf-8");
      try {
        const preEditIdx = dev.buffer.length;
        await fs.writeFile(sourceFile, sourceContent + "\n");

        // Wait for the HMR cycle to complete (gate resolves AFTER the gen
        // file is written, so any cascade from that write would fire
        // before/around this point).
        await waitForLogFromIdx(
          () => dev.buffer,
          /hmr: discoveryDone resolved/,
          "post-edit gate resolution",
          preEditIdx,
        );

        // Grace window for the gen-file fs event to surface in vite's HMR
        // pipeline AFTER the gate resolves. handleHotUpdate fires
        // synchronously when the watcher detects the change; 1500ms is
        // generous even on slow CI inotify.
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Strip ANSI so the matcher and the failure dump are color-agnostic.
        const postEditSlice = stripVTControlCharacters(
          dev.buffer.slice(preEditIdx),
        );
        const cycleCount = (postEditSlice.match(/hmr re-discovery done/g) ?? [])
          .length;
        expect(
          cycleCount,
          `single source edit should produce exactly one HMR rediscovery cycle, got ${cycleCount}.\n--- buffer slice ---\n${postEditSlice}\n--- end slice ---`,
        ).toBe(1);
        expect(dev.unexpectedExit).toBeNull();
      } finally {
        await fs.writeFile(sourceFile, sourceContent);
      }
    } finally {
      await killProcessTree(dev.proc);
      await fs.writeFile(genFilePath, buildGen);
    }
  });
});

interface DevHandle {
  proc: ChildProcess;
  buffer: string;
  /** Mutable: assigned if the dev process exits unexpectedly. */
  unexpectedExit: Error | null;
}

/**
 * Spawn `pnpm dev`, wait for cold-start runtime discovery + a 2.5s settle,
 * and return a handle whose `buffer` accumulates all dev stdout/stderr.
 * The buffer is captured by reference so callers can splice from a known
 * offset (`preEditIdx`) for HMR-only assertions.
 */
async function runDevAndWaitForRediscovery(
  buildGen: string,
): Promise<DevHandle> {
  await fs.writeFile(genFilePath, "// dirty marker\n");
  const handle: { buffer: string; unexpectedExit: Error | null } = {
    buffer: "",
    unexpectedExit: null,
  };

  const proc = spawn("pnpm", ["dev"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      DEBUG: "rango:discovery",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let coldDiscovery!: () => void;
  let coldDiscoveryReject!: (e: Error) => void;
  const coldDone = new Promise<void>((resolve, reject) => {
    coldDiscovery = resolve;
    coldDiscoveryReject = reject;
  });
  let discoverySeen = false;

  const onData = (chunk: Buffer) => {
    handle.buffer += chunk.toString();
    if (
      !discoverySeen &&
      /\[rango\] Router "[^"]+" -> \d+ routes/.test(handle.buffer)
    ) {
      discoverySeen = true;
      coldDiscovery();
    }
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  proc.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGKILL") return;
    handle.unexpectedExit = new Error(
      `dev exited unexpectedly (code=${code}, signal=${signal})\n` +
        `--- captured ---\n${tail(handle.buffer)}`,
    );
    if (!discoverySeen) coldDiscoveryReject(handle.unexpectedExit);
  });

  await Promise.race([
    coldDone,
    new Promise<void>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `dev cold-start runtime discovery did not complete within 90s\n` +
                `--- captured ---\n${tail(handle.buffer)}`,
            ),
          ),
        90_000,
      ),
    ),
  ]);
  // Settle pause matching the existing tests — vite reload fan-out
  // continues for a couple seconds after the first discovery line.
  await new Promise((r) => setTimeout(r, 2500));

  return {
    proc,
    get buffer() {
      return handle.buffer;
    },
    get unexpectedExit() {
      return handle.unexpectedExit;
    },
  } as DevHandle;
}

async function waitForGenFileMissing(
  filePath: string,
  needle: string,
  label: string,
  getBuffer?: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      if (!content.includes(needle)) return;
    } catch {
      // retry
    }
    if (Date.now() - start > timeoutMs) {
      const bufTail = getBuffer
        ? `\n--- captured ---\n${tail(getBuffer())}`
        : "";
      throw new Error(
        `timed out waiting for gen file to NOT contain "${needle}" (${label})${bufTail}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Poll a getter for the current buffer content until a regex matches at or
 * after `fromIdx`. Used by tests that need to wait for a NEW occurrence of a
 * log line without matching prior cold-start instances.
 */
async function waitForLogFromIdx(
  getBuffer: () => string,
  pattern: RegExp,
  label: string,
  fromIdx: number,
  timeoutMs = 30_000,
): Promise<number> {
  const start = Date.now();
  while (true) {
    const buf = getBuffer();
    const slice = buf.slice(fromIdx);
    const m = slice.search(pattern);
    if (m >= 0) return fromIdx + m;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for log "${label}" after offset ${fromIdx}\n--- captured ---\n${tail(buf)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

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

/**
 * Poll the gen file on disk until it contains a target substring. Used to
 * verify that an HMR rediscovery cycle actually wrote its updated output —
 * this is the user-visible contract and is more robust to log-line ordering
 * variability than waiting on internal debug markers.
 *
 * On timeout the captured dev stdout/stderr is appended (when a buffer
 * getter is provided) so the failure is diagnosable without re-running.
 */
async function waitForGenFileContains(
  filePath: string,
  needle: string,
  label: string,
  getBuffer?: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (true) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      if (content.includes(needle)) return;
    } catch {
      // File might be momentarily unreadable mid-write; retry.
    }
    if (Date.now() - start > timeoutMs) {
      const bufTail = getBuffer
        ? `\n--- captured ---\n${tail(getBuffer())}`
        : "";
      throw new Error(
        `timed out waiting for gen file to contain "${needle}" (${label})${bufTail}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function tail(text: string, maxChars = 4000): string {
  if (!text) return "(empty)";
  if (text.length <= maxChars) return text;
  return `...${text.slice(-maxChars)}`;
}
