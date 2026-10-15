import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A runner full reload (#1186) fires vite:beforeFullReload, then clears the
// runner's evaluated modules. A listener on the router copy's hot channel is
// the first, vi.resetModules() the second: what loads after it is a fresh
// copy of the router, as the runner's re-import of the entry evaluates.

const SOURCE_FILE = fileURLToPath(
  new URL("./__fixtures__/reloaded-router.ts", import.meta.url),
);

type Listener = () => void;

/** Fire the runner's full reload at the copy `watch` belongs to. */
function reloadRunner(
  watch: (events: { on(event: string, listener: Listener): void }) => void,
): void {
  const listeners: Listener[] = [];
  watch({ on: (_event, listener) => listeners.push(listener) });
  for (const listener of listeners) listener();
  vi.resetModules();
}

beforeEach(() => {
  vi.resetModules();
});

describe("a router whose module copy a runner full reload dropped", () => {
  it("hands its request to the router the reload re-created", async () => {
    const { createRouter } = await import("../../router.js");
    const { watchRunnerReloads } = await import("../dev-reload-handoff.js");
    const dropped = createRouter({
      id: "reload-handoff",
      $$sourceFile: SOURCE_FILE,
    });

    reloadRunner(watchRunnerReloads);

    const response = await dropped.fetch(new Request("http://localhost/"));
    expect(await response.text()).toBe("re-created router");
    const { router: recreated } = await import(SOURCE_FILE);
    expect(recreated).not.toBe(dropped);
  });

  it("is dropped only once the reload fires", async () => {
    const { droppedByRunnerReload, watchRunnerReloads } =
      await import("../dev-reload-handoff.js");
    expect(droppedByRunnerReload()).toBe(false);

    reloadRunner(watchRunnerReloads);

    expect(droppedByRunnerReload()).toBe(true);
    // The copy the reload evaluates starts current.
    const fresh = await import("../dev-reload-handoff.js");
    expect(fresh.droppedByRunnerReload()).toBe(false);
  });

  it("fails the request with the error of a router module that does not load", async () => {
    const { createRouter } = await import("../../router.js");
    const { watchRunnerReloads } = await import("../dev-reload-handoff.js");
    const missing = fileURLToPath(
      new URL("./__fixtures__/missing-router.ts", import.meta.url),
    );
    const dropped = createRouter({
      id: "reload-handoff",
      $$sourceFile: missing,
    });

    reloadRunner(watchRunnerReloads);

    await expect(
      dropped.fetch(new Request("http://localhost/")),
    ).rejects.toThrow("missing-router.ts");
  });
});
