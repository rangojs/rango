// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import {
  initBrowserApp,
  resetBrowserAppContext,
} from "../browser/rsc-router.js";
import type { RscBrowserDependencies, RscPayload } from "../browser/types.js";

// The order initBrowserApp guarantees for `clearOnReload`: the entry's stale
// slots are gone before the document's Flight payload is decoded, which is
// before any reader hydrates and before a navigation or action payload can
// deliver server-set state. What is removed is history-state.test.ts's
// contract; this pins when.

afterEach(() => {
  resetBrowserAppContext();
  window.history.replaceState(null, "");
});

it("initBrowserApp removes clearOnReload slots before it decodes the payload", async () => {
  const kept = { "__rsc_ls_a1b2c3d4#Sort": { order: "asc" }, idx: 3 };
  window.history.replaceState(
    { ...kept, "__rsc_ls_a1b2c3d4#Carried~r": ["p4", "p5"] },
    "",
  );
  const payload = {
    metadata: { pathname: "/", segments: [], matched: [], params: {} },
  } as unknown as RscPayload;
  const atDecode: unknown[] = [];

  await initBrowserApp({
    rscStream: new ReadableStream<Uint8Array>(),
    deps: {
      createFromReadableStream: async () => {
        atDecode.push(window.history.state);
        return payload;
      },
      createFromFetch: async () => payload,
      setServerCallback: () => {},
      encodeReply: async () => "",
      createTemporaryReferenceSet: () => ({}),
    } as unknown as RscBrowserDependencies,
    linkInterception: false,
  });

  expect(atDecode).toEqual([kept]);
});
