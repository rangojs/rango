import { beforeEach, describe, expect, it } from "vitest";
import { createRouter, urls } from "@rangojs/router";
import { dispatch } from "@rangojs/router/testing";
import {
  resetShellTestState,
  serveShellRequest,
} from "@rangojs/router/testing/flight";
import { includeScopePublicPatterns } from "../src/pages/include-scope.js";

// #1107: serveShellRequest serves a router through the route trie. dispatch
// matches through the same trie, so a router a shell request served answers
// as a fresh one does. The route sets no trailingSlash: like production, the
// trie serves the trailing-slash URL as the route, with no redirect.
const mount = () =>
  createRouter({}).routes(
    urls(({ include }) => [include("/", includeScopePublicPatterns)]),
  );

beforeEach(() => resetShellTestState());

async function answer(router: ReturnType<typeof mount>, url: string) {
  const res = await dispatch(router, { request: url });
  return {
    status: res.status,
    location: res.headers.get("location"),
    body: res.status === 200 ? await res.json() : null,
  };
}

describe("dispatch after serveShellRequest", () => {
  it("answers a trailing-slash URL as a fresh router does", async () => {
    const served = mount();
    await serveShellRequest(served, "/nested-unnamed/login");
    const fresh = await answer(mount(), "/nested-unnamed/login.json/");
    expect(fresh).toEqual({
      status: 200,
      location: null,
      body: { page: "login" },
    });
    expect(await answer(served, "/nested-unnamed/login.json/")).toEqual(fresh);
  });
});
