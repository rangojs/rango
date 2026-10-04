/**
 * Issue #942 with production React (vitest.rsc.config.ts forces production).
 * The development twin is loader-container-jsx-dev.rsc-test.ts.
 */
import { vi } from "vitest";
import { defineLoaderContainerJsxSuite } from "./loader-container-jsx.shared.js";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../../../testing/vitest-stubs/plugin-rsc.js"),
);

defineLoaderContainerJsxSuite("production");
