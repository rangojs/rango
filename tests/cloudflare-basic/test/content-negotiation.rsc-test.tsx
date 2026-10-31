import { describe, expect, it } from "vitest";
import { createRouter, urls } from "@rangojs/router";
import { dispatch } from "@rangojs/router/testing";
import { serveShellRequest } from "@rangojs/router/testing/flight";
import { negotiationPatterns } from "../src/pages/negotiation.js";

// Content negotiation on the app's own negotiated routes
// (src/pages/negotiation.tsx). A response variant's win is served by dispatch
// (the production request stages); an RSC win by serveShellRequest
// (createRSCHandler), which also picks the document or the flight
// representation. e2e/content-negotiation.test.ts keeps a dev and production
// smoke for what these cannot see: the built route trie, workerd and the real
// SSR document. A plain page route's representation is pinned in the router's
// own src/testing/__tests__/content-negotiation.rsc-test.tsx.
const router = createRouter({}).routes(
  urls(({ include }) => [include("/", negotiationPatterns, { name: "" })]),
);

const BROWSER_ACCEPT = "text/html,application/xhtml+xml";
const DOCUMENT = "text/html;charset=utf-8";
const FLIGHT = "text/x-component;charset=utf-8";
const JSON_TYPE = "application/json;charset=utf-8";
const TEXT_TYPE = "text/plain;charset=utf-8";
const XML_TYPE = "application/xml;charset=utf-8";

function expectVaryAcceptOnce(response: Response): void {
  const tokens = (response.headers.get("vary") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase());
  expect(tokens.filter((token) => token === "accept")).toEqual(["accept"]);
}

describe("content negotiation: a response variant wins (dispatch)", () => {
  it.each([
    [
      "JSON-first: application/json",
      "/test/negotiate",
      "application/json",
      JSON_TYPE,
      { format: "json", negotiated: true },
    ],
    [
      "JSON-first: */* picks JSON",
      "/test/negotiate",
      "*/*",
      JSON_TYPE,
      { format: "json", negotiated: true },
    ],
    [
      "JSON-first: an empty Accept picks JSON",
      "/test/negotiate",
      "",
      JSON_TYPE,
      { format: "json", negotiated: true },
    ],
    [
      "JSON-first: no Accept picks JSON",
      "/test/negotiate",
      undefined,
      JSON_TYPE,
      { format: "json", negotiated: true },
    ],
    [
      "text: text/plain",
      "/test/negotiate-text",
      "text/plain",
      TEXT_TYPE,
      "plain text response",
    ],
    [
      "xml: application/xml",
      "/test/negotiate-xml",
      "application/xml",
      XML_TYPE,
      "<item><status>ok</status></item>",
    ],
    [
      "multi: application/json",
      "/test/negotiate-multi",
      "application/json",
      JSON_TYPE,
      { format: "json" },
    ],
    [
      "multi: text/plain",
      "/test/negotiate-multi",
      "text/plain",
      TEXT_TYPE,
      "plain text",
    ],
    [
      "multi: application/xml",
      "/test/negotiate-multi",
      "application/xml",
      XML_TYPE,
      "<root><format>xml</format></root>",
    ],
    [
      "multi: */* picks the first variant (JSON)",
      "/test/negotiate-multi",
      "*/*",
      JSON_TYPE,
      { format: "json" },
    ],
    [
      "wildcard: application/json carries the wildcard param",
      "/test/negotiate-wild/some/path",
      "application/json",
      JSON_TYPE,
      { format: "json", wildcard: "some/path" },
    ],
  ] as const)("%s", async (_title, path, accept, type, body) => {
    const res = await dispatch(router, {
      request: new Request(new URL(path, "http://localhost/"), {
        headers: accept === undefined ? {} : { accept },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expectVaryAcceptOnce(res);
    if (typeof body === "string") expect(await res.text()).toBe(body);
    else expect(await res.json()).toEqual(body);
  });
});

describe("content negotiation: the RSC route wins (serveShellRequest)", () => {
  it.each([
    [
      "JSON-first: a browser Accept",
      "/test/negotiate",
      BROWSER_ACCEPT,
      DOCUMENT,
      "HTML version",
    ],
    [
      "JSON-first: text/x-component",
      "/test/negotiate",
      "text/x-component",
      FLIGHT,
      "HTML version",
    ],
    [
      "text: a browser Accept",
      "/test/negotiate-text",
      BROWSER_ACCEPT,
      DOCUMENT,
      "Text HTML version",
    ],
    [
      "xml: a browser Accept",
      "/test/negotiate-xml",
      BROWSER_ACCEPT,
      DOCUMENT,
      "XML HTML version",
    ],
    [
      "multi: a browser Accept",
      "/test/negotiate-multi",
      BROWSER_ACCEPT,
      DOCUMENT,
      "Multi HTML version",
    ],
    [
      "wildcard: a browser Accept",
      "/test/negotiate-wild/some/path",
      BROWSER_ACCEPT,
      DOCUMENT,
      "Wildcard HTML",
    ],
  ] as const)("%s", async (_title, path, accept, type, text) => {
    const result = await serveShellRequest(router, path, {
      headers: { accept },
    });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toBe(type);
    expect(result.body).toContain(text);
    expectVaryAcceptOnce(result.response);
  });
});
