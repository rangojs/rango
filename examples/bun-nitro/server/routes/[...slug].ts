import { defineEventHandler, toRequest } from "nitro/h3";

export default defineEventHandler(async (event) => {
  let req = toRequest(event);

  // ISR URL rewrite: when Vercel routes through an ISR function, the original
  // URL is captured in __isr_route (via x-now-route-matches header or query param).
  // Extract it and rewrite the request to the original URL.
  const routeMatches = req.headers.get("x-now-route-matches");
  if (routeMatches) {
    const isrRoute = new URLSearchParams(routeMatches).get("__isr_route");
    if (isrRoute) {
      const originalUrl = new URL(decodeURIComponent(isrRoute), new URL(req.url).origin);
      req = new Request(originalUrl.href, req);
    }
  } else {
    const url = new URL(req.url);
    const isrRoute = url.searchParams.get("__isr_route");
    if (isrRoute) {
      const originalUrl = new URL(decodeURIComponent(isrRoute), url.origin);
      req = new Request(originalUrl.href, req);
    }
  }

  // Load the pre-built RSC service at runtime to avoid bundling a separate
  // copy of React into this route (which would conflict with the SSR service's React).
  const servicePath = [".", "_ssr", "index2.mjs"].join("/");
  const rscModule = await import(new URL(servicePath, globalThis.__nitro_main__).href);
  const handler = rscModule.default;
  return handler(req);
});
