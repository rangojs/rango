/**
 * The plugin-rsc stub's loadServerAction resolves `<module id>#<name>` from
 * the modules a test registered. Each has a null prototype, as a production
 * build's server-reference entry does, so an inherited name resolves to
 * nothing.
 */
import { describe, expect, it } from "vitest";
import { registerServerModule } from "../internal/server-modules.js";
import { loadServerAction } from "../vitest-stubs/plugin-rsc.js";

const MODULE = "/src/own-exports-cart.ts";
const INHERITED = ["constructor", "toString", "hasOwnProperty", "__proto__"];

async function saveCart(): Promise<string> {
  return "saved";
}
async function clearCart(): Promise<string> {
  return "cleared";
}

async function inheritedNames(): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};
  for (const name of INHERITED) {
    resolved[name] = await loadServerAction(`${MODULE}#${name}`);
  }
  return resolved;
}

const NOTHING = Object.fromEntries(INHERITED.map((name) => [name, undefined]));

describe("plugin-rsc stub loadServerAction", () => {
  registerServerModule(MODULE, { saveCart });

  it("resolves a registered export", async () => {
    expect(await loadServerAction(`${MODULE}#saveCart`)).toBe(saveCart);
  });

  it("resolves an inherited name to nothing", async () => {
    expect(await inheritedNames()).toEqual(NOTHING);
  });

  it("keeps the null prototype when a later call adds an export", async () => {
    registerServerModule(MODULE, { clearCart });
    expect(await loadServerAction(`${MODULE}#clearCart`)).toBe(clearCart);
    expect(await inheritedNames()).toEqual(NOTHING);
  });
});
