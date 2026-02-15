import { defineEventHandler, toRequest } from "nitro/h3";

export default defineEventHandler(async (event) => {
  const req = toRequest(event);
  // Load the pre-built RSC service at runtime to avoid bundling a separate
  // copy of React into this route (which would conflict with the SSR service's React).
  const servicePath = [".", "_ssr", "index2.mjs"].join("/");
  const rscModule = await import(new URL(servicePath, globalThis.__nitro_main__).href);
  const handler = rscModule.default;
  return handler(req);
});
