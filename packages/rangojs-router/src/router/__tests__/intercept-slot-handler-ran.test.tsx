/**
 * resolveInterceptEntry (router/intercept-resolution.ts) marks the slot's
 * segment `_handlerRan` as resolveEntryHandler and resolveOrphanLayout mark
 * theirs: true when the slot's handler ran for this pass, false when a fill
 * keeps the slot the client holds. A partial match lists the marked ids in
 * `resolvedIds` (match-result.ts), and the browser's handle merge clears the
 * old pushes of a run listed there (handles/pushed-by.ts). Unmarked, a modal
 * that re-ran and pushed nothing kept its previous pushes.
 *
 * The userland version is
 * src/testing/__tests__/serve-shell-request-intercept-resolved-ids.rsc-test.tsx.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";

import { resolveInterceptEntry } from "../intercept-resolution.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import type { EntryData, InterceptEntry } from "../../server/context.js";
import type { SegmentResolutionDeps } from "../types.js";

const SLOT = "M0L0.@modal";

function makeDeps(): SegmentResolutionDeps<any> {
  return {
    wrapLoaderPromise: vi.fn((promise: any) => promise) as any,
    trackHandler: vi.fn((p) => p),
    findNearestErrorBoundary: vi.fn(() => null),
    findNearestNotFoundBoundary: vi.fn(() => null),
    callOnError: vi.fn(),
  };
}

function makeContext(): any {
  return {
    request: new Request("https://example.com/item/1"),
    env: {},
    params: {},
    pathname: "/item/1",
    url: new URL("https://example.com/item/1"),
    var: {},
    use: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  };
}

function intercept(overrides: Partial<InterceptEntry> = {}): InterceptEntry {
  return {
    slotName: "@modal",
    routeName: "item",
    handler: () => <dialog>modal</dialog>,
    loader: [],
    when: [],
    ...overrides,
  };
}

function parentEntry(): EntryData {
  return {
    id: "layout",
    type: "layout",
    shortCode: "M0L0",
    handler: () => <main>shell</main>,
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    handle: [],
  } as any;
}

/** The slot segment resolveInterceptEntry returns for `held`/`mode`. */
async function slotOf(
  entry: InterceptEntry,
  options: { held?: string[]; fill?: boolean } = {},
): Promise<{ id: string; component: unknown; _handlerRan?: boolean }> {
  const context = makeContext();
  if (options.fill) context._prefetchDeferral = { mode: "fill" };
  const pass = {
    context,
    client: new Set(options.held ?? []),
    params: {},
    prevParams: {},
    request: context.request,
    prevUrl: context.url,
    nextUrl: context.url,
    routeKey: "item",
    deps: makeDeps(),
  } as any;
  // An erroring handler reports through the request context (status 500).
  const reqCtx = createRequestContext({
    env: {},
    request: context.request,
    url: context.url,
    variables: {},
  } as any);
  const segments = await runWithRequestContext(reqCtx, () =>
    resolveInterceptEntry(pass, entry, parentEntry(), true),
  );
  return segments.find((s) => s.id === SLOT) as any;
}

describe("an intercept slot's segment says whether its handler ran", () => {
  it("true when the handler runs", async () => {
    const handler = vi.fn(() => <dialog>modal</dialog>);
    const slot = await slotOf(intercept({ handler }));
    expect(slot._handlerRan).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("true when an async handler is awaited", async () => {
    const handler = vi.fn(async () => <dialog>modal</dialog>);
    const slot = await slotOf(intercept({ handler }));
    expect(slot._handlerRan).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("true for a static handler, which renders without one", async () => {
    const slot = await slotOf(intercept({ handler: <dialog>modal</dialog> }));
    expect(slot._handlerRan).toBe(true);
  });

  it("true when the handler throws into the declaring layout's boundary", async () => {
    const slot = await slotOf(
      intercept({
        handler: () => {
          throw new Error("modal failed");
        },
      }),
    );
    expect(slot._handlerRan).toBe(true);
    expect(slot.component).toBeTruthy();
  });

  it("false on a fill that keeps the held slot", async () => {
    const handler = vi.fn(() => <dialog>modal</dialog>);
    const slot = await slotOf(intercept({ handler }), {
      held: [SLOT],
      fill: true,
    });
    expect(slot._handlerRan).toBe(false);
    expect(slot.component).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("true on a fill that sends a slot the client lacks", async () => {
    const handler = vi.fn(() => <dialog>modal</dialog>);
    const slot = await slotOf(intercept({ handler }), { fill: true });
    expect(slot._handlerRan).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
