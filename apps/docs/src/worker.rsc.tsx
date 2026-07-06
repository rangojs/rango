/// <reference types="@cloudflare/workers-types" />

import type { AppEnv } from "./env";
import { router } from "./router";

// No path filtering here: static assets (favicon, images) are served by the
// assets binding before the worker runs, and /.well-known/mcp.json is a real
// route (see src/urls.tsx), so every request that reaches us goes to the
// router.
export default {
  async fetch(request, env, ctx) {
    return router.fetch(request, { env, ctx });
  },
} satisfies ExportedHandler<AppEnv>;
