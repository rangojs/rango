import { describe, expect, it } from "vitest";
import {
  parseAcceptTypes,
  pickNegotiateVariant,
  RSC_RESPONSE_TYPE,
} from "../content-negotiation";

describe("parseAcceptTypes", () => {
  it("parses simple Accept header", () => {
    const result = parseAcceptTypes("application/json");
    expect(result).toEqual([{ mime: "application/json", q: 1, order: 0 }]);
  });

  it("sorts by q-value descending", () => {
    const result = parseAcceptTypes("text/html;q=0.9, application/json;q=1.0");
    expect(result[0]!.mime).toBe("application/json");
    expect(result[1]!.mime).toBe("text/html");
  });

  it("uses client order as tiebreaker for equal q-values", () => {
    const result = parseAcceptTypes("text/html, application/json");
    expect(result[0]!.mime).toBe("text/html");
    expect(result[1]!.mime).toBe("application/json");
  });

  it("clamps q-value to [0, 1]", () => {
    const result = parseAcceptTypes("text/html;q=5.0, text/plain;q=-1");
    expect(result[0]!.q).toBe(1);
    expect(result[1]!.q).toBe(0);
  });

  it("treats invalid q-value as 0", () => {
    const result = parseAcceptTypes("text/html;q=abc");
    expect(result[0]!.q).toBe(0);
  });

  it("handles empty string", () => {
    const result = parseAcceptTypes("");
    expect(result).toEqual([]);
  });

  it("skips empty segments from extra commas", () => {
    const result = parseAcceptTypes("text/html,,application/json,");
    const mimes = result.map((e) => e.mime);
    expect(mimes).toEqual(["text/html", "application/json"]);
  });

  it("handles whitespace around MIME types", () => {
    const result = parseAcceptTypes("  text/html , application/json  ");
    expect(result[0]!.mime).toBe("text/html");
    expect(result[1]!.mime).toBe("application/json");
  });

  it("normalizes mixed-case MIME types to lowercase", () => {
    const result = parseAcceptTypes("Application/JSON, Text/HTML;q=0.9");
    expect(result[0]!.mime).toBe("application/json");
    expect(result[1]!.mime).toBe("text/html");
  });

  it("handles multiple parameters beyond q", () => {
    const result = parseAcceptTypes("text/html;charset=utf-8;q=0.8");
    expect(result[0]!.q).toBe(0.8);
    expect(result[0]!.mime).toBe("text/html");
  });

  it("parses a realistic browser Accept header", () => {
    const result = parseAcceptTypes(
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    );
    expect(result[0]!.mime).toBe("text/html");
    expect(result[1]!.mime).toBe("application/xhtml+xml");
    expect(result[2]!.mime).toBe("application/xml");
    expect(result[3]!.mime).toBe("*/*");
    expect(result[2]!.q).toBe(0.9);
    expect(result[3]!.q).toBe(0.8);
  });
});

describe("pickNegotiateVariant", () => {
  const jsonCandidate = { routeKey: "api.data", responseType: "json" };
  const htmlCandidate = { routeKey: "page.index", responseType: "html" };
  const rscCandidate = {
    routeKey: "rsc.page",
    responseType: RSC_RESPONSE_TYPE,
  };
  const textCandidate = { routeKey: "api.text", responseType: "text" };

  it("picks exact MIME match", () => {
    const accept = parseAcceptTypes("application/json");
    const result = pickNegotiateVariant(accept, [htmlCandidate, jsonCandidate]);
    expect(result).toBe(jsonCandidate);
  });

  it("falls back to first candidate when no match", () => {
    const accept = parseAcceptTypes("image/png");
    const result = pickNegotiateVariant(accept, [jsonCandidate, htmlCandidate]);
    expect(result).toBe(jsonCandidate);
  });

  it("respects q=0 exclusion", () => {
    const accept = parseAcceptTypes("application/json;q=0, text/html;q=1.0");
    const result = pickNegotiateVariant(accept, [jsonCandidate, htmlCandidate]);
    expect(result).toBe(htmlCandidate);
  });

  it("wildcard matches first candidate", () => {
    const accept = parseAcceptTypes("*/*");
    const result = pickNegotiateVariant(accept, [jsonCandidate, htmlCandidate]);
    expect(result).toBe(jsonCandidate);
  });

  it("type wildcard matches first candidate of that type", () => {
    const accept = parseAcceptTypes("text/*");
    const result = pickNegotiateVariant(accept, [
      jsonCandidate,
      htmlCandidate,
      textCandidate,
    ]);
    expect(result).toBe(htmlCandidate);
  });

  it("matches mixed-case Accept against lowercase candidates", () => {
    const accept = parseAcceptTypes("Application/JSON");
    const result = pickNegotiateVariant(accept, [htmlCandidate, jsonCandidate]);
    expect(result).toBe(jsonCandidate);
  });

  it("matches mixed-case type wildcard", () => {
    const accept = parseAcceptTypes("Text/*");
    const result = pickNegotiateVariant(accept, [jsonCandidate, htmlCandidate]);
    expect(result).toBe(htmlCandidate);
  });

  it("treats RSC response type as text/html for negotiation", () => {
    const accept = parseAcceptTypes("text/html");
    const result = pickNegotiateVariant(accept, [jsonCandidate, rscCandidate]);
    expect(result).toBe(rscCandidate);
  });

  it("prefers higher q-value when multiple types match", () => {
    const accept = parseAcceptTypes("application/json;q=0.5, text/html;q=0.9");
    const result = pickNegotiateVariant(accept, [jsonCandidate, htmlCandidate]);
    expect(result).toBe(htmlCandidate);
  });

  it("handles empty Accept entries gracefully", () => {
    const accept = parseAcceptTypes("");
    const result = pickNegotiateVariant(accept, [jsonCandidate]);
    expect(result).toBe(jsonCandidate);
  });
});
