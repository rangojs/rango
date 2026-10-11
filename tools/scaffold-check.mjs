// Builds create-rango apps the way a consumer does: no lockfile, newest
// semver-compatible dependencies. CI builds from the monorepo lockfile, so a
// dependency release that breaks fresh installs (plugin-rsc 0.5.36 vs router
// 0.21.0/0.22.0) is invisible there. Per template: scaffold, install, build,
// start the dev server and GET / expecting 200.
//
// Run: node tools/scaffold-check.mjs [--templates cloudflare,basic]
//        [--router <path.tgz>] [--router-version <semver>] [--keep]
// Templates: cloudflare, basic, vercel, basic-js (= basic --js).
// Exits non-zero if any template fails to build or serve.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ALL = ["cloudflare", "basic", "vercel", "basic-js"];
const DEV_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 15 * 60_000;

const args = process.argv.slice(2);
const VALUE_FLAGS = ["templates", "router", "router-version"];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--keep") continue;
  if (VALUE_FLAGS.includes(a.replace(/^--/, "")) && a.startsWith("--")) {
    if (args[++i] === undefined) {
      console.error(`Missing value for ${a}`);
      process.exit(2);
    }
    continue;
  }
  console.error(
    `Unknown argument "${a}". Flags: ${[...VALUE_FLAGS, "keep"].map((f) => `--${f}`).join(", ")}`,
  );
  process.exit(2);
}
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const templates = opt("templates")?.split(",") ?? ALL;
const routerTgz = opt("router") && resolve(opt("router"));
const routerVersion = opt("router-version");
const keep = args.includes("--keep");

for (const t of templates) {
  if (!ALL.includes(t)) {
    console.error(`Unknown template "${t}". Known: ${ALL.join(", ")}`);
    process.exit(2);
  }
}

function run(cmd, cmdArgs, cwd, label) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    env: { ...process.env, CI: "true" },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error || r.status !== 0) {
    const why = r.error ? String(r.error) : `exit ${r.status}`;
    console.error(
      `\n--- ${label} failed (${why}) ---\n${out.split("\n").slice(-40).join("\n")}`,
    );
    return false;
  }
  return true;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

function pkgVersion(dir, name) {
  try {
    return JSON.parse(
      readFileSync(join(dir, "node_modules", name, "package.json"), "utf8"),
    ).version;
  } catch {
    return "-";
  }
}

let activeKill;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    activeKill?.("SIGKILL");
    process.exit(130);
  });
}

async function devCheck(dir, label) {
  const port = await freePort();
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--port", String(port), "--strictPort"],
    {
      cwd: dir,
      env: { ...process.env, CI: "true" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  let exited = false;
  const exitedP = new Promise((r) =>
    child.on("exit", () => ((exited = true), r())),
  );
  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // already gone
    }
  };
  activeKill = killGroup;
  const deadline = Date.now() + DEV_TIMEOUT_MS;
  let status = "no response";
  try {
    while (Date.now() < deadline && !exited) {
      try {
        const res = await fetch(`http://localhost:${port}/`, {
          signal: AbortSignal.timeout(10_000),
        });
        status = String(res.status);
        if (res.status === 200) break;
      } catch {
        // server not up yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    // Only the process group this script spawned.
    if (!exited) {
      killGroup("SIGTERM");
      const timer = setTimeout(() => killGroup("SIGKILL"), 5000);
      await exitedP;
      clearTimeout(timer);
    }
    activeKill = undefined;
  }
  if (exited && status !== "200") status = "exited";
  if (status !== "200") {
    console.error(
      `\n--- ${label} dev failed (${status}) ---\n${log.split("\n").slice(-40).join("\n")}`,
    );
  }
  return status;
}

const root = mkdtempSync(join(tmpdir(), "scaffold-check-"));
const rows = [];

for (const t of templates) {
  const row = {
    template: t,
    router: "-",
    source: routerTgz ? "tarball" : "registry",
    pluginRsc: "-",
    vite: "-",
    build: "FAIL",
    dev: "-",
  };
  rows.push(row);
  const dir = join(root, t);
  mkdirSync(dir, { recursive: true });
  const base = t === "basic-js" ? "basic" : t;
  const create = [
    "-y",
    "create-rango@latest",
    "app",
    "--template",
    base,
    "--package-manager",
    "npm",
  ];
  if (t === "basic-js") create.push("--js");
  console.log(`[${t}] scaffold`);
  if (!run("npx", create, dir, `${t} scaffold`)) continue;
  const app = join(dir, "app");

  const pj = join(app, "package.json");
  const pkg = JSON.parse(readFileSync(pj, "utf8"));
  // Always explicit: create-rango's registry lookup can fail and keep an old pin.
  pkg.dependencies["@rangojs/router"] = routerTgz
    ? `file:${routerTgz}`
    : (routerVersion ?? "latest");
  writeFileSync(pj, JSON.stringify(pkg, null, 2));

  console.log(`[${t}] npm install`);
  const installed = run(
    "npm",
    ["install", "--no-audit", "--no-fund"],
    app,
    `${t} install`,
  );
  row.router = pkgVersion(app, "@rangojs/router");
  row.pluginRsc = pkgVersion(app, "@vitejs/plugin-rsc");
  row.vite = pkgVersion(app, "vite");
  if (!installed) continue;

  console.log(`[${t}] npm run build`);
  if (!run("npm", ["run", "build"], app, `${t} build`)) continue;
  row.build = "ok";

  console.log(`[${t}] dev server GET /`);
  row.dev = await devCheck(app, t);
}

console.log("\ntemplate    router   source   plugin-rsc  vite     build  dev");
for (const r of rows) {
  console.log(
    [
      r.template.padEnd(11),
      r.router.padEnd(8),
      r.source.padEnd(8),
      r.pluginRsc.padEnd(11),
      r.vite.padEnd(8),
      r.build.padEnd(6),
      r.dev,
    ].join(" "),
  );
}
if (keep) console.log(`\nKept: ${root}`);
else rmSync(root, { recursive: true, force: true });
process.exit(rows.every((r) => r.build === "ok" && r.dev === "200") ? 0 : 1);
