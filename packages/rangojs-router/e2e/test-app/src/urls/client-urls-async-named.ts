import { urls } from "@rangojs/router";
import clientUrlsInterceptPatterns from "./client-urls-intercept.js";

/**
 * Async include module mounting a clientUrls() group — with EVERY segment
 * NAMED. Nested lazy includes require explicit names: unnamed segments get
 * counter-allocated auto-names ($prefix_N scope ids, $path_* route names)
 * that diverge between discovery's single-pass walk and runtime nested lazy
 * expansion, and requests then 404 at entry resolution. Named includes and
 * routes have deterministic names, so nothing diverges — pinned by the
 * async-include e2e in client-urls.test.ts (dev + production).
 */
export default urls(({ include }) => [
  include("/nested", clientUrlsInterceptPatterns, { name: "nested" }),
]);
