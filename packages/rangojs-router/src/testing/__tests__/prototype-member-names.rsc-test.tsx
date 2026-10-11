/**
 * Userland: route segments named like Object.prototype members match their
 * own routes and nothing else (#1109). serveShellRequest serves through the
 * router's real handler, which builds the route trie on first request.
 * Building it used to write a `/__proto__` route's leaf onto
 * Object.prototype, so every trie node without a route of its own inherited
 * it: `/blog` rendered the `/__proto__` page instead of a 404.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const router = createRouter({}).routes(
  urls(({ path }) => [
    path("/constructor", () => <p>constructor page</p>, { name: "ctor" }),
    path("/toString", () => <p>toString page</p>, { name: "str" }),
    path("/__proto__", () => <p>proto page</p>, { name: "proto" }),
    path("/blog/:id", () => <p>post page</p>, { name: "post" }),
  ]),
);

beforeEach(() => resetShellTestState());
afterAll(() => {
  // A failing run must not leave the leak behind for the next file.
  for (const o of [Object.prototype, Object, Object.prototype.toString]) {
    delete (o as unknown as Record<string, unknown>).r;
  }
});

describe("routes named like Object.prototype members", () => {
  it.each([
    ["/constructor", "constructor page"],
    ["/toString", "toString page"],
    ["/__proto__", "proto page"],
    ["/blog/1", "post page"],
  ])("%s renders its own route", async (url, text) => {
    const result = await serveShellRequest(router, url);
    expect(result.response.status).toBe(200);
    expect(result.body).toContain(text);
  });

  it.each(["/blog", "/hasOwnProperty", "/valueOf/x"])(
    "%s is a 404",
    async (url) => {
      const result = await serveShellRequest(router, url);
      expect(result.response.status).toBe(404);
      expect(result.body).not.toContain("proto page");
    },
  );
});
