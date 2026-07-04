/// <reference types="@cloudflare/workers-types" />
import { enableMatchDebug } from "@rangojs/router/__internal";
import { router } from "./router.js";
import { parseServerTiming } from "./server-timing.js";
import type { AppBindings } from "./env.js";

// Pre-generated route manifest: eliminates ~98ms first-request cost of
// evaluating lazy includes. Generated at build time by the discovery plugin.
import "virtual:rsc-router/routes-manifest";

// enableMatchDebug is a module-global toggle but env bindings are only
// visible inside fetch, so it is configured once on the first request.
let matchDebugConfigured = false;

export default {
  async fetch(request, env, ctx) {
    if (!matchDebugConfigured) {
      matchDebugConfigured = true;
      enableMatchDebug(env.MATCH_DEBUG === "1");
    }
    const requestStart = performance.now();
    const dateStart = Date.now();
    const url = new URL(request.url);

    // Skip browser metadata requests
    if (
      url.pathname === "/favicon.ico" ||
      url.pathname.startsWith("/.well-known/")
    ) {
      return new Response(null, { status: 404 });
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Handle /timing/* convenience route: makes internal sub-request,
    // returns Server-Timing as structured JSON. The caller's accept header is
    // forwarded (default text/html) so the profiled code path matches what a
    // real client would trigger, and the body is fully consumed BEFORE the
    // clock stops — otherwise streamed render time after first byte would be
    // silently excluded from totalMs.
    if (url.pathname.startsWith("/timing/")) {
      const targetPath = "/" + url.pathname.slice("/timing/".length);
      const targetUrl = new URL(targetPath + url.search, url.origin);
      const subRequest = new Request(targetUrl.toString(), {
        method: "GET",
        headers: { accept: request.headers.get("accept") || "text/html" },
      });

      const subStart = performance.now();
      const subResponse = await router.fetch(subRequest, {
        env,
        vars: { requestStart: subStart, dateStart: Date.now() },
        ctx,
      });
      const subBody = await subResponse.arrayBuffer();
      const subDur = performance.now() - subStart;

      const serverTiming = subResponse.headers.get("Server-Timing") || "";
      const entries = parseServerTiming(serverTiming);

      return new Response(
        JSON.stringify(
          {
            path: targetPath,
            status: subResponse.status,
            totalMs: parseFloat(subDur.toFixed(2)),
            bodyBytes: subBody.byteLength,
            serverTimingRaw: serverTiming,
            timings: entries,
          },
          null,
          2,
        ),
        {
          headers: {
            "Content-Type": "application/json",
            "Server-Timing": `total-request;dur=${subDur.toFixed(2)}`,
          },
        },
      );
    }

    const response = await router.fetch(request, {
      env,
      vars: { requestStart, dateStart },
      ctx,
    });

    // Append total-request duration to Server-Timing header
    const totalDur = performance.now() - requestStart;
    const existingTiming = response.headers.get("Server-Timing");
    const totalTiming = `total-request;dur=${totalDur.toFixed(2)}`;
    const fullTiming = existingTiming
      ? `${existingTiming}, ${totalTiming}`
      : totalTiming;

    // Clone response with updated Server-Timing header
    const newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    newResponse.headers.set("Server-Timing", fullTiming);

    return newResponse;
  },
} satisfies ExportedHandler<AppBindings>;
