import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_URL = pathToFileURL(
  resolve(__dirname, "../plugins/cloudflare-protocol-loader-hook.mjs"),
).href;

/**
 * Verifies the loader hook works when the module graph bypasses Vite
 * entirely — i.e. the exact scenario that motivated adding the hook on
 * top of the Vite transform. Spawns a Node subprocess that registers the
 * hook and then does a bare `import("cloudflare:workers")` via Node's
 * native ESM loader. Without the hook this fails with ERR_UNSUPPORTED…
 * With the hook it returns our stub classes.
 */
describe("cloudflare-protocol-loader-hook (integration via child Node)", () => {
  it("resolves cloudflare:workers when registered as a Node loader", async () => {
    const script = `
      import { register } from "node:module";
      register(${JSON.stringify(HOOK_URL)});
      const mod = await import("cloudflare:workers");
      class MyDO extends mod.DurableObject {}
      class MyWE extends mod.WorkerEntrypoint {}
      const instance = new MyDO();
      const we = new MyWE();
      console.log(JSON.stringify({
        durableObject: instance instanceof mod.DurableObject,
        workerEntrypoint: we instanceof mod.WorkerEntrypoint,
        envIsEmpty: Object.keys(mod.env).length === 0,
      }));
    `;
    const { stdout } = await execFileP(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 15_000 },
    );
    expect(JSON.parse(stdout.trim())).toEqual({
      durableObject: true,
      workerEntrypoint: true,
      envIsEmpty: true,
    });
  });

  it("surfaces a descriptive error for unsupported cloudflare:* specifiers", async () => {
    const script = `
      import { register } from "node:module";
      register(${JSON.stringify(HOOK_URL)});
      try {
        await import("cloudflare:email");
        console.log("NO_ERROR");
      } catch (err) {
        console.log(err.message);
      }
    `;
    const { stdout } = await execFileP(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 15_000 },
    );
    expect(stdout).toMatch(/Unsupported `cloudflare:email`/);
  });
});
