/**
 * A `Prerender` + `ppr` route through serveShellRequest (issue #1057): the
 * prerender store supplies the handler layer, so the shell entry has no doc
 * record, and the loader-owned handle pushes its prelude rendered are kept
 * in the entry's own record instead. A HIT hydrates with them, as a plain
 * `ppr` shell's does.
 *
 * `source.generation` moves to 2 after the capture: a value from the capture
 * reads @g1, one from a run on the HIT reads @g2.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  type ServeShellRequestResult,
  type ShellRequestHandles,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  Prerender,
  urls,
} from "../../index.rsc.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { shellHarness, source } from "./fixtures/shell-request-data.js";

const Notes = createHandle<string>();

/** Prerender handler runs: the bake only, never a HIT. */
const bakes = { handler: 0 };

/** A promise-free `ssr: false` loader: a HIT serves its pin, its body does not run. */
const SettledNoted = createLoader(async (ctx) => {
  ctx.use(Notes)(`settled-only@g${source.generation}`);
  return { value: `settled@g${source.generation}` };
});

/** Promise-free, with a deferred push the shell cannot keep (`runs`). */
const DeferredNoted = createLoader(async (ctx) => {
  ctx.use(Notes)(`settled-note@g${source.generation}`);
  ctx.use(Notes)(Promise.resolve(`deferred-note@g${source.generation}`));
  return { value: `deferred@g${source.generation}` };
});

function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, loader }) => [
      path(
        "/pre-settled",
        Prerender((ctx) => {
          bakes.handler += 1;
          ctx.use(Notes)("handler-note");
          return <p>pre settled</p>;
        }),
        { name: "preSettled", ppr: { ttl: 300, swr: 120 } },
        () => [loader(SettledNoted, { ssr: false })],
      ),
      path(
        "/pre-capped",
        Prerender((ctx) => {
          ctx.use(Notes)("handler-note");
          return <p>pre capped</p>;
        }),
        {
          name: "preCapped",
          ppr: { ttl: 300, swr: 120, maxSnapshotBytes: 1 },
        },
        () => [loader(SettledNoted, { ssr: false })],
      ),
      path(
        "/pre-deferred",
        Prerender(() => <p>pre deferred</p>),
        { name: "preDeferred", ppr: { ttl: 300, swr: 120 } },
        () => [loader(DeferredNoted, { ssr: false })],
      ),
      path(
        "/ppr-settled",
        (ctx) => {
          ctx.use(Notes)("handler-note");
          return <p>ppr settled</p>;
        },
        { name: "pprSettled", ppr: { ttl: 300, swr: 120 } },
        () => [loader(SettledNoted, { ssr: false })],
      ),
    ]),
  );
}

const setup = () => shellHarness(makeRouter());

/** The handle data the HIT's shell was rendered from (the capture's payload). */
async function shellHandles(
  result: ServeShellRequestResult,
): Promise<ShellRequestHandles["hydration"] | undefined> {
  if (result.prelude === undefined) return undefined;
  const { metadata } = await deserializeResult<{
    metadata?: { handles?: AsyncIterable<ShellRequestHandles["hydration"]> };
  }>(result.prelude);
  let handles: ShellRequestHandles["hydration"] = {};
  for await (const data of metadata?.handles ?? []) handles = data;
  return handles;
}

/**
 * A document's handle values in push order: what its shell was rendered
 * from, what the client hydrates with, and the state the late channel leaves
 * it in (undefined when nothing arrived late).
 */
async function handleValues(result: ServeShellRequestResult): Promise<{
  shell: unknown[] | undefined;
  hydration: unknown[];
  afterHydration: unknown[] | undefined;
}> {
  const handles = (await result.readHandles())!;
  const values = (data: ShellRequestHandles["hydration"] | undefined) =>
    data &&
    Object.values(data).flatMap((bySegment) => Object.values(bySegment).flat());
  return {
    shell: values(await shellHandles(result)),
    hydration: values(handles.hydration)!,
    afterHydration: values(handles.late.at(-1)),
  };
}

/** Capture `path` at generation 1, then serve its HIT at generation 2. */
async function hitAfterCapture(path: string) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const harness = setup();
  const miss = await harness.serve(path);
  expect(miss.shellStatus).toBe("MISS");
  source.generation = 2;
  const hit = await harness.serve(path);
  expect(hit.shellStatus).toBe("HIT");
  return { ...harness, miss, hit, values: await handleValues(hit) };
}

beforeEach(async () => {
  source.generation = 1;
  bakes.handler = 0;
  await resetShellTestState();
});

describe("a Prerender + ppr shell HIT hydrates with the loader pushes its shell rendered (#1057)", () => {
  it("a promise-free ssr: false loader's settled push is in the hydration data, as in the shell", async () => {
    const { hit, values } = await hitAfterCapture("/pre-settled");

    // Served by the prerender store: no doc record, no handler run on the HIT.
    expect((await hit.readEntry())?.docKey).toBeUndefined();
    expect(bakes.handler).toBe(1);
    // The loader's data is its pin; its body did not run.
    expect(hit.flight).toContain("settled@g1");
    expect(hit.flight).not.toContain("settled@g2");
    expect(values.shell).toEqual(["handler-note", "settled-only@g1"]);
    expect(values.hydration).toEqual(values.shell);
    expect(values.afterHydration).toBeUndefined();
  });

  it("a promise push is not in the shell and arrives after hydration, next to the settled push the shell kept (#1054)", async () => {
    const { values } = await hitAfterCapture("/pre-deferred");

    expect(values.shell).toEqual(["settled-note@g1"]);
    expect(values.hydration).toEqual(values.shell);
    // The pin asks for a run (`runs`): its settled push gives way to the
    // shell's copy, its deferred one is added.
    expect(values.afterHydration).toEqual([
      "settled-note@g1",
      "deferred-note@g2",
    ]);
  });

  it("an entry without loader pins (maxSnapshotBytes) hydrates with the capture's push, and the run's push takes its place after hydration", async () => {
    const { values } = await hitAfterCapture("/pre-capped");

    expect(values.shell).toEqual(["handler-note", "settled-only@g1"]);
    expect(values.hydration).toEqual(values.shell);
    expect(values.afterHydration).toEqual(["handler-note", "settled-only@g2"]);
  });

  it("a plain ppr route keeps the same push in its doc record (control)", async () => {
    const { hit, values } = await hitAfterCapture("/ppr-settled");

    expect((await hit.readEntry())?.docKey).toBeDefined();
    // Rendered live at capture: the loader kicks off before the handler.
    expect(values.shell).toEqual(["settled-only@g1", "handler-note"]);
    expect(values.hydration).toEqual(values.shell);
    expect(values.afterHydration).toBeUndefined();
  });

  it("an entry stored before the record existed (0.21.0) still serves, as it did", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve, cacheStore } = setup();
    const miss = await serve("/pre-settled");
    const stored = (await miss.readEntry())!;
    await cacheStore.putShell(
      miss.key,
      {
        ...stored,
        snapshot: stored.snapshot.filter(
          (record) => (record.family as string) !== "handles",
        ),
      },
      300,
      120,
    );
    source.generation = 2;

    const hit = await serve("/pre-settled");

    expect(hit.shellStatus).toBe("HIT");
    expect(hit.flight).toContain("settled@g1");
    const values = await handleValues(hit);
    expect(values.hydration).toEqual(["handler-note"]);
    expect(values.afterHydration).toBeUndefined();
  });
});
