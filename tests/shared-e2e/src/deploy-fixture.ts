import { spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * A fixture app a test can deploy repeatedly: build it, serve the build, stop
 * the server, change the source, build again.
 *
 * Why it exists: the per-router cache versions are a property of a BUILD, and
 * what they promise is only visible across two builds and a server restart
 * (does the entry the first build wrote survive the second). No shared
 * Playwright webServer can show that, and rebuilding a shared app would pull
 * the dist/ out from under every other test using it. So each suite gets a
 * private copy of a small fixture, with its own output directory, its own
 * server and its own port.
 *
 * Shared by the node suite (packages/rangojs-router/e2e) and the Cloudflare
 * suite (tests/cloudflare-basic/e2e): both drive `vite build` and
 * `vite preview` of a fixture that has no package.json and resolves its
 * dependencies through the app directory it sits in.
 */
export interface DeployFixtureOptions {
  /** Directory of the fixture to copy (contains vite.config.ts and src/). */
  source: string;
  /** Where the working copy goes. Removed first, and again by cleanup(). */
  workDir: string;
  /** The app directory whose node_modules/.bin/vite builds and serves it. */
  appDir: string;
  /** Port `vite preview` listens on. */
  port: number;
  /** Environment for every build and server (e.g. the encryption key). */
  env?: Record<string, string>;
  /** Path polled until the server answers. Defaults to "/". */
  readyPath?: string;
  /** Request headers for the readiness poll (e.g. a host-override cookie). */
  readyHeaders?: Record<string, string>;
}

export interface DeployFixture {
  readonly root: string;
  /** Rewrite one source file of the working copy. */
  edit(file: string, change: (source: string) => string): void;
  /** `vite build` the working copy; resolves with the build output. */
  build(): Promise<string>;
  /** Start `vite preview` and wait until it answers. */
  start(): Promise<void>;
  /** Stop the server and wait until the port is free. */
  stop(): Promise<void>;
  /** build() then a server restart: one deploy. */
  deploy(): Promise<string>;
  url(pathname: string): string;
  /** Stop the server and remove the working copy. */
  cleanup(): Promise<void>;
}

const COPY_SKIP = new Set(["dist", ".vite", "node_modules", ".wrangler"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDeployFixture(
  options: DeployFixtureOptions,
): DeployFixture {
  const { source, workDir, appDir, port } = options;
  const vite = path.join(appDir, "node_modules", ".bin", "vite");
  const config = path.join(workDir, "vite.config.ts");
  // CI=true: vite exits when stdin reaches EOF otherwise (see fixture.ts).
  const env = { ...process.env, CI: "true", ...options.env };
  let server: ChildProcess | undefined;
  let serverOutput = "";

  rmSync(workDir, { recursive: true, force: true });
  cpSync(source, workDir, {
    recursive: true,
    filter: (entry) =>
      !COPY_SKIP.has(path.basename(entry)) && !entry.endsWith(".gen.ts"),
  });

  const origin = `http://localhost:${port}`;

  async function isUp(): Promise<boolean> {
    try {
      const res = await fetch(origin + (options.readyPath ?? "/"), {
        headers: options.readyHeaders,
        signal: AbortSignal.timeout(2_000),
      });
      await res.body?.cancel();
      return true;
    } catch {
      return false;
    }
  }

  async function stop(): Promise<void> {
    const child = server;
    server = undefined;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", resolve));
    try {
      // The server is a process-group leader (detached), so this also reaps
      // what it spawned (workerd under the Cloudflare plugin).
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill();
    }
    await Promise.race([exited, sleep(10_000)]);
    for (let i = 0; i < 50 && (await isUp()); i++) await sleep(100);
  }

  const fixture: DeployFixture = {
    root: workDir,
    edit(file, change) {
      const target = path.join(workDir, file);
      const before = readFileSync(target, "utf-8");
      const after = change(before);
      if (after === before) {
        throw new Error(`deploy fixture: edit of ${file} changed nothing`);
      }
      writeFileSync(target, after);
    },
    build() {
      return new Promise((resolve, reject) => {
        const child = spawn(vite, ["build", "--config", config], {
          cwd: appDir,
          env,
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve(output)
            : reject(new Error(`vite build failed (exit ${code}):\n${output}`)),
        );
      });
    },
    async start() {
      if (await isUp()) {
        throw new Error(
          `deploy fixture: something already answers on ${origin}; ` +
            `set RANGO_E2E_PORT_OFFSET to move this checkout's ports`,
        );
      }
      serverOutput = "";
      const child = spawn(
        vite,
        ["preview", "--config", config, "--port", String(port), "--strictPort"],
        { cwd: appDir, env, detached: true },
      );
      server = child;
      child.stdout!.on("data", (chunk) => (serverOutput += chunk));
      child.stderr!.on("data", (chunk) => (serverOutput += chunk));
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(
            `vite preview exited (code ${child.exitCode}):\n${serverOutput}`,
          );
        }
        if (await isUp()) return;
        await sleep(150);
      }
      throw new Error(
        `vite preview did not answer on ${origin}:\n${serverOutput}`,
      );
    },
    stop,
    async deploy() {
      const output = await fixture.build();
      await stop();
      await fixture.start();
      return output;
    },
    url: (pathname) => origin + pathname,
    async cleanup() {
      await stop();
      if (existsSync(workDir))
        rmSync(workDir, { recursive: true, force: true });
    },
  };
  return fixture;
}

/** The `data / document` pair `vite build` prints for a router source file. */
export function readBuiltVersions(
  buildOutput: string,
  routerSource: string,
): { data: string; document: string } {
  const escaped = routerSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = buildOutput.match(
    new RegExp(`([0-9a-f]{16}) / ([0-9a-f]{16})\\s+${escaped}`),
  );
  if (!match) {
    throw new Error(
      `no cache versions for ${routerSource} in the build output:\n${buildOutput}`,
    );
  }
  return { data: match[1]!, document: match[2]! };
}
