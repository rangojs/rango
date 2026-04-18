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
 * entirely — the exact scenario that motivates the hook's existence.
 * Vite/Rollup externalize certain packages (e.g. `partyserver`) and
 * delegate their imports to Node's native ESM loader, which rejects
 * `cloudflare:*` URL schemes. This test spawns a Node subprocess that
 * registers the hook and then does bare `import("cloudflare:*")` calls
 * via Node's native ESM loader.
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

  it("resolves cloudflare:email so third-party packages (e.g. agents SDK, partyserver) don't break", async () => {
    const script = `
      import { register } from "node:module";
      register(${JSON.stringify(HOOK_URL)});
      const mod = await import("cloudflare:email");
      class MyEmail extends mod.EmailMessage {}
      console.log(JSON.stringify({
        emailMessage: new MyEmail() instanceof mod.EmailMessage,
      }));
    `;
    const { stdout } = await execFileP(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 15_000 },
    );
    expect(JSON.parse(stdout.trim())).toEqual({ emailMessage: true });
  });

  it("resolves unknown cloudflare:* specifiers to a permissive empty stub", async () => {
    const script = `
      import { register } from "node:module";
      register(${JSON.stringify(HOOK_URL)});
      const mod = await import("cloudflare:something-new");
      console.log(JSON.stringify({
        defaultIsEmpty: Object.keys(mod.default).length === 0,
      }));
    `;
    const { stdout } = await execFileP(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 15_000 },
    );
    expect(JSON.parse(stdout.trim())).toEqual({ defaultIsEmpty: true });
  });
});
