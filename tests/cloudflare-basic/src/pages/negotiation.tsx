import { urls } from "@rangojs/router";

// Content negotiation: several routes on one URL, picked by Accept.
// test/content-negotiation.rsc-test.tsx serves these routes in-process;
// e2e/content-negotiation.test.ts keeps a dev and production smoke.
export const negotiationPatterns = urls(({ path }) => [
  // JSON defined before the RSC route: */* picks JSON.
  path.json(
    "/test/negotiate",
    () => ({
      format: "json",
      negotiated: true,
    }),
    { name: "testNegotiateJson" },
  ),
  path("/test/negotiate", () => <div>HTML version</div>, {
    name: "testNegotiate",
  }),

  path("/test/negotiate-text", () => <div>Text HTML version</div>, {
    name: "testNegotiateText",
  }),
  path.text("/test/negotiate-text", () => "plain text response", {
    name: "testNegotiateTextApi",
  }),

  path("/test/negotiate-xml", () => <div>XML HTML version</div>, {
    name: "testNegotiateXml",
  }),
  path.xml("/test/negotiate-xml", () => "<item><status>ok</status></item>", {
    name: "testNegotiateXmlApi",
  }),

  path.json("/test/negotiate-multi", () => ({ format: "json" }), {
    name: "testNegotiateMultiJson",
  }),
  path.text("/test/negotiate-multi", () => "plain text", {
    name: "testNegotiateMultiText",
  }),
  path.xml("/test/negotiate-multi", () => "<root><format>xml</format></root>", {
    name: "testNegotiateMultiXml",
  }),
  path("/test/negotiate-multi", () => <div>Multi HTML version</div>, {
    name: "testNegotiateMulti",
  }),

  path.json(
    "/test/negotiate-wild/*",
    (ctx) => ({
      format: "json",
      wildcard: (ctx.params as Record<string, string>)["*"],
    }),
    { name: "testNegotiateWildJson" },
  ),
  path("/test/negotiate-wild/*", () => <div>Wildcard HTML</div>, {
    name: "testNegotiateWild",
  }),
]);
