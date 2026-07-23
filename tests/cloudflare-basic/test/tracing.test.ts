import { describe, expect, it } from "vitest";
import { createRouter } from "@rangojs/router";
import { createCloudflareTracing } from "@rangojs/router/cloudflare";
import type { AppBindings } from "../src/env.js";

// Dogfood the createCloudflareTracing wiring through createRouter in the
// consumer app's build env. router.tracing is the resolved span-tracing the
// handler reads per phase; this pins the option -> field plumbing and the
// off-by-default safety invariant. (The full app router in src/router.tsx wires
// tracing: createCloudflareTracing(); a fresh router here keeps the test light.)
describe("cloudflare tracing wiring", () => {
  it("resolves the tracing option onto router.tracing", () => {
    const r = createRouter<AppBindings>({
      tracing: createCloudflareTracing(),
    });
    expect((r as { tracing?: unknown }).tracing).toBeDefined();
  });

  it("leaves tracing undefined when the option is omitted", () => {
    const bare = createRouter<AppBindings>({});
    expect((bare as { tracing?: unknown }).tracing).toBeUndefined();
  });

  it("disables tracing when enabled is false", () => {
    const off = createRouter<AppBindings>({
      tracing: createCloudflareTracing({ enabled: false }),
    });
    expect((off as { tracing?: unknown }).tracing).toBeUndefined();
  });
});
