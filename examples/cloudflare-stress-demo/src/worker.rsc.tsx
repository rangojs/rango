/// <reference types="@cloudflare/workers-types" />
import { router } from "./router.js";
import type { AppBindings } from "./env.js";

// Pre-generated route manifest: eliminates ~98ms first-request cost of
// evaluating lazy includes. Generated at build time by the discovery plugin.
import "virtual:rsc-router/routes-manifest";

export default {
  async fetch(request, env, ctx) {
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
    // returns Server-Timing as structured JSON
    if (url.pathname.startsWith("/timing/")) {
      const targetPath = "/" + url.pathname.slice("/timing/".length);
      const targetUrl = new URL(targetPath + url.search, url.origin);
      const subRequest = new Request(targetUrl.toString(), {
        method: "GET",
        headers: { accept: "text/html" },
      });

      const subStart = performance.now();
      const subResponse = await router.fetch(subRequest, {
        Bindings: env,
        Variables: { requestStart: subStart, dateStart: Date.now() },
        ctx,
      });
      const subDur = performance.now() - subStart;

      const serverTiming = subResponse.headers.get("Server-Timing") || "";

      // Parse Server-Timing into structured data
      const entries: Record<string, number> = {};
      if (serverTiming) {
        for (const part of serverTiming.split(",")) {
          const trimmed = part.trim();
          const nameMatch = trimmed.match(/^([^;]+)/);
          const durMatch = trimmed.match(/dur=([0-9.]+)/);
          if (nameMatch && durMatch) {
            entries[nameMatch[1].trim()] = parseFloat(durMatch[1]);
          }
        }
      }

      return new Response(
        JSON.stringify(
          {
            path: targetPath,
            totalMs: parseFloat(subDur.toFixed(2)),
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
      Bindings: env,
      Variables: { requestStart, dateStart },
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
