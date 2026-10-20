/**
 * Issue #1213, through serveShellRequest: a `ppr` route whose
 * `loader(Def, { ssr: false })` resolved at capture and later answers
 * notFound() or redirect() (the record was deleted or moved upstream).
 *
 * Past the shell's ttl, the stale document HIT serves the entry and
 * recaptures. The recapture refuses: a bake-lane notFound()/redirect() means
 * the URL has no shell. The refusal retires the key's stored entries, the
 * document shell and the navigation-only entry beside it, so the next
 * document and navigation render live. Before the fix the refusal only backed
 * the key off, and both kept serving the deleted record (its pinned data and
 * its Meta title, status 200) for the whole SWR window.
 *
 * A loader that rejects is a failure, not an answer about the URL: the stale
 * entry keeps serving and the key only backs off, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState } from "../flight.entry.js";
import {
  createLoader,
  createRouter,
  Meta,
  notFound,
  redirect,
  urls,
} from "../../index.rsc.js";
import type { MemorySegmentCacheStore } from "../../cache/index.js";
import {
  shellHarness,
  type ShellHarness,
} from "./fixtures/shell-request-data.js";

/** The upstream records: id -> name. A missing id is a deleted record. */
const records = new Map<string, string>();
/** Ids whose record moved to `/item/moved`. */
const moved = new Set<string>();
/** Ids whose upstream read fails. */
const failing = new Set<string>();

async function readRecord(id: string): Promise<string> {
  if (failing.has(id)) throw new Error(`upstream down for ${id}`);
  if (moved.has(id)) throw redirect("/item/moved");
  const name = records.get(id);
  if (name === undefined) notFound(`No record ${id}`);
  return name;
}

/** Promise-free: a HIT and a navigation replay serve its pin. */
const ItemLoader = createLoader(async (ctx) => {
  const name = await readRecord(ctx.params.id!);
  ctx.use(Meta)({ title: `title:${name}` });
  return { name: `name:${name}` };
});

/** A nested promise: a HIT runs it and overlays its pin. */
const HoleyItemLoader = createLoader(async (ctx) => {
  const name = await readRecord(ctx.params.id!);
  ctx.use(Meta)({ title: `title:${name}` });
  return { name: `name:${name}`, later: Promise.resolve(`later:${name}`) };
});

const PPR = { ttl: 10, swr: 1000 };

const router = createRouter({}).routes(
  urls(({ path, loader }) => [
    path("/", () => <p>home</p>, { name: "home" }),
    path(
      "/item/:id",
      () => <p>item page</p>,
      { name: "item", ppr: PPR },
      () => [loader(ItemLoader, { ssr: false })],
    ),
    path(
      "/holey/:id",
      () => <p>holey page</p>,
      { name: "holey", ppr: PPR },
      () => [loader(HoleyItemLoader, { ssr: false })],
    ),
  ]),
);

type Serve = ShellHarness<typeof router, MemorySegmentCacheStore>["serve"];

let clockOffset = 0;

/** Move the shell clock past the entries' ttl, inside their swr window. */
function pastTtl(): void {
  clockOffset += (PPR.ttl + 1) * 1000;
}

beforeEach(async () => {
  records.clear();
  moved.clear();
  failing.clear();
  records.set("1", "Widget");
  clockOffset = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Store both entries of `path`: a cold navigation captures the
 * navigation-only entry, then a document captures the document shell.
 */
async function captureBoth(serve: Serve, path: string): Promise<void> {
  const cold = await serve(path, { partial: { from: "/" } });
  expect(cold.replayStatus).toEqual({ outcome: "BYPASS", reason: "no-entry" });
  const replay = await serve(path, { partial: { from: "/" } });
  expect(replay.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
  expect((await serve(path)).shellStatus).toBe("MISS");
  const hit = await serve(path);
  expect(hit.shellStatus).toBe("HIT");
  expect(hit.prelude).toContain("name:Widget");
}

describe("serveShellRequest: an ssr: false loader that answers notFound() or redirect() after the capture (#1213)", () => {
  it.each([
    ["a promise-free loader (pinned)", "/item/1"],
    ["a loader with a nested promise (overlaid)", "/holey/1"],
  ])(
    "notFound(), %s: the stale HIT's recapture retires the shell, so the next document is a live 404 and a navigation does not replay",
    async (_label, path) => {
      const { serve } = shellHarness(router);
      await captureBoth(serve, path);

      records.delete("1");
      pastTtl();

      // SWR: the stale entry serves this one response and recaptures.
      const stale = await serve(path);
      expect(stale.shellStatus).toBe("HIT");
      expect(stale.response.status).toBe(200);

      const document = await serve(path);
      expect(document.shellStatus).toBe("MISS");
      expect(document.response.status).toBe(404);
      expect(document.body).not.toContain("name:Widget");
      expect(document.body).not.toContain("title:Widget");
      const entry = await document.readEntry();
      expect(entry).toMatchObject({ navigationOnly: true, snapshot: [] });
      expect(entry?.docKey).toBeUndefined();

      // Neither the document shell nor the navigation-only entry replays.
      const nav = await serve(path, { partial: { from: "/" } });
      expect(nav.replayStatus).toEqual({
        outcome: "BYPASS",
        reason: "no-segment-snapshot",
      });
      expect(nav.flight).not.toContain("name:Widget");
      expect(nav.flight).not.toContain("title:Widget");
      expect(nav.flight).toContain('"notFound":true');
    },
  );

  it("redirect(): the stale HIT's recapture retires the shell, so the next document and navigation answer the redirect live", async () => {
    const { serve } = shellHarness(router);
    await captureBoth(serve, "/item/1");

    moved.add("1");
    pastTtl();
    expect((await serve("/item/1")).shellStatus).toBe("HIT");

    const document = await serve("/item/1");
    expect(document.shellStatus).toBe("MISS");
    expect(document.body).not.toContain("name:Widget");
    expect(document.body).toContain("/item/moved");

    const nav = await serve("/item/1", { partial: { from: "/" } });
    expect(nav.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "no-segment-snapshot",
    });
    expect(nav.flight).not.toContain("name:Widget");
    expect(nav.flight).toContain("/item/moved");
  });

  it("a loader that rejects keeps the stale shell serving: the key only backs off", async () => {
    const { serve } = shellHarness(router);
    await captureBoth(serve, "/item/1");

    failing.add("1");
    pastTtl();
    expect((await serve("/item/1")).shellStatus).toBe("HIT");

    const document = await serve("/item/1");
    expect(document.shellStatus).toBe("HIT");
    expect(document.response.status).toBe(200);
    expect(document.prelude).toContain("name:Widget");
    const nav = await serve("/item/1", { partial: { from: "/" } });
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "stale" });
    expect(nav.flight).toContain("name:Widget");
  });
});
