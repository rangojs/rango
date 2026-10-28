/**
 * Content negotiation through the public request primitives, on a
 * self-contained router: /negotiate-test (RSC, JSON, Markdown),
 * /negotiate-test-json-first (JSON, RSC), /negotiate-mw-test (a middleware per
 * variant) and a plain route. A response variant's win is served by dispatch
 * (the production request stages); an RSC win by serveShellRequest
 * (createRSCHandler), which also picks the document or the flight
 * representation. Every negotiated response carries `accept` in Vary exactly
 * once (D6). The e2e smoke in e2e/content-negotiation.test.ts keeps what these
 * cannot see: the built route trie and the real SSR document.
 */
import { describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { serveShellRequest } from "../flight.entry.js";
import { dispatch } from "../index.js";
import { createRouter, urls } from "../../index.rsc.js";

const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const DOCUMENT = "text/html;charset=utf-8";
const FLIGHT = "text/x-component;charset=utf-8";
const JSON_TYPE = "application/json;charset=utf-8";
const MD_TYPE = "text/markdown;charset=utf-8";
const MARKDOWN = "# Negotiate Test MD\n\nMarkdown content.";
const JSON_BODY = { source: "json" };
const RSC_FIRST_PAGE = "Negotiate Test RSC";
const JSON_FIRST_PAGE = "Negotiate JSON-First RSC";

const router = createRouter({}).routes(
  urls(({ path, middleware }) => [
    path("/", () => <main data-testid="index-page">Home</main>, {
      name: "home",
    }),
    path("/negotiate-test", () => <h1>{RSC_FIRST_PAGE}</h1>, {
      name: "negotiateTest",
    }),
    path.json("/negotiate-test", () => ({ source: "json" }), {
      name: "negotiateTestJson",
    }),
    path.md("/negotiate-test", () => MARKDOWN, { name: "negotiateTestMd" }),
    path.json("/negotiate-test-json-first", () => ({ source: "json" }), {
      name: "negotiateJsonFirst",
    }),
    path("/negotiate-test-json-first", () => <h1>{JSON_FIRST_PAGE}</h1>, {
      name: "negotiateJsonFirstRsc",
    }),
    path(
      "/negotiate-mw-test",
      () => <h1>Negotiate MW RSC</h1>,
      { name: "negotiateMwRsc" },
      () => [
        middleware(async (ctx, next) => {
          await next();
          ctx.header("X-Variant-Mw", "html");
        }),
      ],
    ),
    path.json(
      "/negotiate-mw-test",
      () => ({ source: "json" }),
      { name: "negotiateMwJson" },
      () => [
        middleware(async (ctx, next) => {
          await next();
          ctx.header("X-Variant-Mw", "json");
        }),
      ],
    ),
  ]),
);

function expectVaryAcceptOnce(response: Response): void {
  const tokens = (response.headers.get("vary") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase());
  expect(tokens.filter((token) => token === "accept")).toEqual(["accept"]);
}

/** A response variant's answer; `accept` undefined sends no Accept header. */
function variant(path: string, accept?: string): Promise<Response> {
  return dispatch(router, {
    request: new Request(new URL(path, "http://localhost/"), {
      headers: accept === undefined ? {} : { accept },
    }),
  });
}

/** The RSC route's answer through the production handler. */
function rsc(path: string, accept: string) {
  return serveShellRequest(router, path, { headers: { accept } });
}

describe("content negotiation: a response variant wins (dispatch)", () => {
  it.each([
    [
      "client order: markdown listed first",
      "/negotiate-test",
      "text/markdown, text/html, */*",
      MD_TYPE,
      MARKDOWN,
    ],
    [
      "client order: JSON listed first",
      "/negotiate-test",
      "application/json, text/html",
      JSON_TYPE,
      JSON_BODY,
    ],
    [
      "q-value: text/html;q=0.9 loses to text/markdown",
      "/negotiate-test",
      "text/html;q=0.9, text/markdown",
      MD_TYPE,
      MARKDOWN,
    ],
    [
      "q-value: application/json;q=0.8 loses to text/markdown;q=0.9",
      "/negotiate-test",
      "application/json;q=0.8, text/markdown;q=0.9",
      MD_TYPE,
      MARKDOWN,
    ],
    [
      "single type: text/markdown",
      "/negotiate-test",
      "text/markdown",
      MD_TYPE,
      MARKDOWN,
    ],
    [
      "single type: application/json",
      "/negotiate-test",
      "application/json",
      JSON_TYPE,
      JSON_BODY,
    ],
    [
      "*/* picks the JSON route defined first",
      "/negotiate-test-json-first",
      "*/*",
      JSON_TYPE,
      JSON_BODY,
    ],
    [
      "an empty Accept picks the JSON route defined first",
      "/negotiate-test-json-first",
      "",
      JSON_TYPE,
      JSON_BODY,
    ],
    [
      "no Accept picks the JSON route defined first",
      "/negotiate-test-json-first",
      undefined,
      JSON_TYPE,
      JSON_BODY,
    ],
  ] as const)("%s", async (_title, path, accept, type, body) => {
    const res = await variant(path, accept);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expectVaryAcceptOnce(res);
    if (typeof body === "string") expect(await res.text()).toBe(body);
    else expect(await res.json()).toEqual(body);
  });

  it("runs the winning variant's own middleware", async () => {
    const res = await variant("/negotiate-mw-test", "application/json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(JSON_TYPE);
    expect(res.headers.get("x-variant-mw")).toBe("json");
    expect(await res.json()).toEqual(JSON_BODY);
    expectVaryAcceptOnce(res);
  });
});

describe("content negotiation: the RSC route wins (serveShellRequest)", () => {
  it.each([
    [
      "client order: HTML listed first",
      "/negotiate-test",
      "text/html, text/markdown, */*",
      DOCUMENT,
      RSC_FIRST_PAGE,
    ],
    [
      "q-value: text/markdown;q=0.5 loses to text/html",
      "/negotiate-test",
      "text/markdown;q=0.5, text/html",
      DOCUMENT,
      RSC_FIRST_PAGE,
    ],
    [
      "a browser Accept",
      "/negotiate-test",
      BROWSER_ACCEPT,
      DOCUMENT,
      RSC_FIRST_PAGE,
    ],
    [
      "*/* picks the RSC route defined first",
      "/negotiate-test",
      "*/*",
      DOCUMENT,
      RSC_FIRST_PAGE,
    ],
    [
      "an empty Accept picks the RSC route defined first",
      "/negotiate-test",
      "",
      DOCUMENT,
      RSC_FIRST_PAGE,
    ],
    [
      "text/x-component on an RSC-first route",
      "/negotiate-test",
      "text/x-component",
      FLIGHT,
      RSC_FIRST_PAGE,
    ],
    [
      "text/x-component on a JSON-first route",
      "/negotiate-test-json-first",
      "text/x-component",
      FLIGHT,
      JSON_FIRST_PAGE,
    ],
  ] as const)("%s", async (_title, path, accept, type, page) => {
    const result = await rsc(path, accept);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toBe(type);
    expect(result.body).toContain(page);
    expectVaryAcceptOnce(result.response);
  });

  it("runs the RSC route's middleware when the document wins", async () => {
    const result = await rsc("/negotiate-mw-test", "text/html");
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toBe(DOCUMENT);
    expect(result.response.headers.get("x-variant-mw")).toBe("html");
    expectVaryAcceptOnce(result.response);
  });
});

describe("content negotiation: a plain RSC route (no variants)", () => {
  it.each([
    ["*/*", "*/*", DOCUMENT],
    ["an empty Accept", "", DOCUMENT],
    ["application/json (no JSON variant)", "application/json", DOCUMENT],
    ["text/x-component", "text/x-component", FLIGHT],
  ] as const)("%s", async (_title, accept, type) => {
    const result = await rsc("/", accept);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toBe(type);
    expect(result.body).toContain("index-page");
  });
});
