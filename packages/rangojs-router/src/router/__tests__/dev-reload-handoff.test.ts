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

describe("a runner full reload that lands while the request runs", () => {
  async function loadHandoff() {
    const handoff = await import("../dev-reload-handoff.js");
    return {
      serveAcrossRunnerReload: handoff.serveAcrossRunnerReload,
      reload: () => reloadRunner(handoff.watchRunnerReloads),
    };
  }

  const recreatedAnswer = async () => async () =>
    new Response("re-created router");

  it("re-runs a GET that failed after the reload on the re-created router", async () => {
    const { serveAcrossRunnerReload, reload } = await loadHandoff();

    const response = await serveAcrossRunnerReload(
      new Request("http://localhost/"),
      async () => {
        reload();
        throw new Error("has no server registration");
      },
      recreatedAnswer,
    );

    expect(await response.text()).toBe("re-created router");
  });

  it("discards a GET response served across the reload and cancels its body", async () => {
    const { serveAcrossRunnerReload, reload } = await loadHandoff();
    const cancel = vi.fn();
    const split = new Response(new ReadableStream({ cancel }));

    const response = await serveAcrossRunnerReload(
      new Request("http://localhost/"),
      async () => {
        reload();
        return split;
      },
      recreatedAnswer,
    );

    expect(await response.text()).toBe("re-created router");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps the outcome of a POST, which a re-run would repeat", async () => {
    const { serveAcrossRunnerReload, reload } = await loadHandoff();
    const recreated = vi.fn(recreatedAnswer);

    await expect(
      serveAcrossRunnerReload(
        new Request("http://localhost/", { method: "POST", body: "a=1" }),
        async () => {
          reload();
          throw new Error("split action");
        },
        recreated,
      ),
    ).rejects.toThrow("split action");
    expect(recreated).not.toHaveBeenCalled();
  });

  it("keeps the outcome when no router was re-created", async () => {
    const { serveAcrossRunnerReload, reload } = await loadHandoff();

    await expect(
      serveAcrossRunnerReload(
        new Request("http://localhost/"),
        async () => {
          reload();
          throw new Error("has no server registration");
        },
        async () => undefined,
      ),
    ).rejects.toThrow("has no server registration");
  });

  it("leaves a request no reload touched alone", async () => {
    const { serveAcrossRunnerReload } = await loadHandoff();
    const recreated = vi.fn(recreatedAnswer);
    const served = new Response("this router");

    const response = await serveAcrossRunnerReload(
      new Request("http://localhost/"),
      async () => served,
      recreated,
    );

    expect(response).toBe(served);
    expect(recreated).not.toHaveBeenCalled();
  });
});
