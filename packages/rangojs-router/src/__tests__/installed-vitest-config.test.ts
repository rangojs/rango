import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// QA-the-quickstart guard. The documented `vitest.config.ts` is loaded by NODE,
// and Node >= 23 refuses to type-strip `.ts` under node_modules — so an external
// consumer importing the setup preset got ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
// before `./testing/vitest` was shipped as compiled JS. This is the ONLY guard
// that reproduces that: it copies the package into node_modules so its realpath
// is UNDER node_modules. The sibling `installed-consumer-imports.test.ts`
// symlinks the package, whose realpath is OUTSIDE node_modules (pnpm layout), so
// Node strips its types fine and the regression hides there — exactly how it
// shipped originally.

const packageRoot = resolve(import.meta.dirname, "..", "..");
const distVitest = join(packageRoot, "dist", "testing", "vitest.js");

describe("installed vitest config (real node_modules realpath)", () => {
  // Static contract — always runs (no build needed). Catches a revert of the
  // export map back to `.ts` or dropping the build step that emits the JS entry.
  it("ships ./testing/vitest as compiled JS, built by `pnpm build`", () => {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf-8"),
    );
    const entry = pkg.exports["./testing/vitest"];
    expect(entry.default).toMatch(/\.js$/);
    expect(entry.default).toContain("dist/");
    // types may stay on source; the runtime default must be the compiled entry.
    expect(pkg.scripts.build).toContain("dist/testing/vitest.js");
  });

  // Dynamic proof — runs whenever the dist artifact exists (always in CI, which
  // builds the router before unit tests; locally after `pnpm build-router`).
  it.skipIf(!existsSync(distVitest))(
    "the documented quickstart preset loads under Node from an installed layout",
    () => {
      const tmp = mkdtempSync(join(tmpdir(), "rango-quickstart-"));
      try {
        const pkgDir = join(tmp, "node_modules", "@rangojs", "router");
        mkdirSync(join(pkgDir, "dist", "testing"), { recursive: true });
        // Real copies (not symlinks) so the realpath is under node_modules.
        copyFileSync(
          join(packageRoot, "package.json"),
          join(pkgDir, "package.json"),
        );
        copyFileSync(distVitest, join(pkgDir, "dist", "testing", "vitest.js"));
        // The alias targets are computed paths into the shipped src/*.ts; touch
        // them so the preset's existsSync round-trip in the loader script passes.
        for (const rel of [
          "src/index.rsc.ts",
          "src/testing/vitest-stubs/version.ts",
          "src/testing/vitest-stubs/plugin-rsc.ts",
          "src/testing/vitest-stubs/cloudflare-workers.ts",
          "src/testing/vitest-stubs/cloudflare-email.ts",
        ]) {
          const p = join(pkgDir, rel);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, "");
        }
        // The SKILL/docs quickstart, verbatim — if this import throws, the
        // documented getting-started config is broken for a real consumer.
        writeFileSync(
          join(tmp, "load.mjs"),
          `import { rangoTestConfig } from "@rangojs/router/testing/vitest";
import { existsSync } from "node:fs";
const cfg = rangoTestConfig({ preset: "cloudflare" });
if (cfg.alias.length !== 5) throw new Error("expected 5 aliases, got " + cfg.alias.length);
if (!cfg.server.deps.inline.length) throw new Error("missing server.deps.inline");
if (!cfg.alias.every((a) => existsSync(a.replacement)))
  throw new Error("alias targets do not resolve to shipped src files");
console.log("QUICKSTART_OK");
`,
        );
        const result = spawnSync(process.execPath, [join(tmp, "load.mjs")], {
          cwd: tmp,
          encoding: "utf-8",
        });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        expect(output, output).toContain("QUICKSTART_OK");
        expect(result.status).toBe(0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
