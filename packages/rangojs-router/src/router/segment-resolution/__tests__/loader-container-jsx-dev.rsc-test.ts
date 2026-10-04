/**
 * Issue #942 with development React, where Flight refuses an element that lost
 * its dev-only fields ("Attempted to render <x> without development
 * properties"). vitest.rsc.config.ts forces production; this file switches
 * NODE_ENV before anything loads React (each rsc-test file runs in its own
 * fork), so the suite module is imported dynamically. The mock factories run
 * on first import, after the switch.
 */
import { vi } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);

process.env.NODE_ENV = "development";

const { defineLoaderContainerJsxSuite } =
  await import("./loader-container-jsx.shared.js");

defineLoaderContainerJsxSuite("development");
