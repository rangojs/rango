// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import {
  initBrowserApp,
  resetBrowserAppContext,
} from "../browser/rsc-router.js";
import type { RscBrowserDependencies, RscPayload } from "../browser/types.js";

// The order initBrowserApp guarantees for `clearOnReload` slots and intercept
// marks: they are gone from the entry before the document's Flight payload is
// decoded, which is before any reader hydrates and before a navigation or
// action payload can deliver server-set state. What is removed is
// history-state.test.ts's contract; this pins when.

afterEach(() => {
  resetBrowserAppContext();
  window.history.replaceState(null, "");
});

async function bootReadingStateAtDecode(): Promise<unknown[]> {
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
  return atDecode;
}

it("initBrowserApp removes clearOnReload slots before it decodes the payload", async () => {
  const kept = { "__rsc_ls_a1b2c3d4#Sort": { order: "asc" }, idx: 3 };
  window.history.replaceState(
    { ...kept, "__rsc_ls_a1b2c3d4#Carried~r": ["p4", "p5"] },
    "",
  );

  expect(await bootReadingStateAtDecode()).toEqual([kept]);
});

// A document request never renders an intercept, so the entry a document
// load starts on (a reload, a Back that loaded a document) is a full page for
// later Back/Forward.
it("initBrowserApp drops the entry's intercept marks before it decodes the payload, keeping key, idx and location state", async () => {
  const kept = {
    "__rsc_ls_a1b2c3d4#Sort": { order: "asc" },
    idx: 2,
    key: "entry-key",
  };
  window.history.replaceState(
    { ...kept, intercept: true, sourceUrl: "http://localhost/list" },
    "",
  );

  expect(await bootReadingStateAtDecode()).toEqual([kept]);
});
