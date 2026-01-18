/**
 * Tests for RSC helpers, specifically createResponseWithMergedHeaders
 */
import { describe, it, expect } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import { createResponseWithMergedHeaders } from "../helpers.js";

describe("createResponseWithMergedHeaders", () => {
  it("should create response without context", () => {
    const response = createResponseWithMergedHeaders("body", { status: 200 });
    expect(response.status).toBe(200);
  });

  it("should merge headers from stub response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    // Set header on stub response
    ctx.res.headers.set("X-Custom", "value");

    const response = runWithRequestContext(ctx, () => {
      return createResponseWithMergedHeaders("body", { status: 200 });
    });

    expect(response.headers.get("X-Custom")).toBe("value");
  });

  it("should trigger onResponse callbacks", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    let callbackCalled = false;
    let capturedStatus: number | undefined;

    ctx.onResponse((res) => {
      callbackCalled = true;
      capturedStatus = res.status;
      return res;
    });

    runWithRequestContext(ctx, () => {
      createResponseWithMergedHeaders("body", { status: 201 });
    });

    expect(callbackCalled).toBe(true);
    expect(capturedStatus).toBe(201);
  });

  it("should allow callbacks to modify response", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.onResponse((res) => {
      const headers = new Headers(res.headers);
      headers.set("X-Added-By-Callback", "yes");
      return new Response(res.body, { status: res.status, headers });
    });

    const response = runWithRequestContext(ctx, () => {
      return createResponseWithMergedHeaders("body", { status: 200 });
    });

    expect(response.headers.get("X-Added-By-Callback")).toBe("yes");
  });

  it("should keep original response if callback returns undefined", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.onResponse((_res) => {
      // Oops, forgot to return response
      return undefined as any;
    });

    const response = runWithRequestContext(ctx, () => {
      return createResponseWithMergedHeaders("body", { status: 200 });
    });

    expect(response.status).toBe(200);
  });

  it("should chain multiple callback modifications", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    ctx.onResponse((res) => {
      const headers = new Headers(res.headers);
      headers.set("X-First", "1");
      return new Response(res.body, { status: res.status, headers });
    });

    ctx.onResponse((res) => {
      const headers = new Headers(res.headers);
      headers.set("X-Second", "2");
      return new Response(res.body, { status: res.status, headers });
    });

    const response = runWithRequestContext(ctx, () => {
      return createResponseWithMergedHeaders("body", { status: 200 });
    });

    expect(response.headers.get("X-First")).toBe("1");
    expect(response.headers.get("X-Second")).toBe("2");
  });

  it("should pass correct status to callbacks for error responses", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    const capturedStatuses: number[] = [];

    ctx.onResponse((res) => {
      capturedStatuses.push(res.status);
      return res;
    });

    runWithRequestContext(ctx, () => {
      createResponseWithMergedHeaders("Not Found", { status: 404 });
    });

    expect(capturedStatuses).toEqual([404]);
  });

  it("should pass correct status to callbacks for redirects", () => {
    const ctx = createRequestContext({
      env: {},
      request: new Request("https://example.com"),
      url: new URL("https://example.com"),
      variables: {},
    });

    let capturedStatus: number | undefined;

    ctx.onResponse((res) => {
      capturedStatus = res.status;
      return res;
    });

    runWithRequestContext(ctx, () => {
      createResponseWithMergedHeaders(null, {
        status: 308,
        headers: { Location: "/new-url" },
      });
    });

    expect(capturedStatus).toBe(308);
  });
});
