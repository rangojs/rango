/**
 * The route name a response carries (payload metadata.routeName) is what the
 * browser's transition({ when }) sees as `to.routeName` / `from.routeName`.
 * Internal names (an unnamed path(), a hidden include scope) never leave the
 * server: they read as undefined, like the optimistic clientUrls() path.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const inner = urls(({ path }) => [
  path("/named", () => <p>inner named</p>, { name: "named" }),
]);

const router = createRouter({}).routes(
  urls(({ path, layout, include }) => [
    layout(
      () => <main>shell</main>,
      () => [
        path("/unnamed", () => <p>unnamed</p>),
        path("/named", () => <p>named</p>, { name: "named" }),
        include("/scoped", inner),
      ],
    ),
  ]),
);

function metadataRouteName(flight: string | undefined): unknown {
  const row = flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  const { metadata } = JSON.parse(row!.slice(2)) as {
    metadata: Record<string, unknown>;
  };
  // Flight encodes undefined as "$undefined".
  return metadata.routeName === undefined || metadata.routeName === "$undefined"
    ? "(absent)"
    : metadata.routeName;
}

beforeEach(() => resetShellTestState());

describe("payload metadata.routeName (transition({ when }) route names)", () => {
  it.each([
    ["/named", "named"],
    ["/unnamed", "(absent)"],
    ["/scoped/named", "(absent)"],
  ])("a partial response for %s carries %s", async (url, expected) => {
    const result = await serveShellRequest(router, url, {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/named" },
    });
    expect(metadataRouteName(result.flight)).toBe(expected);
  });
});
