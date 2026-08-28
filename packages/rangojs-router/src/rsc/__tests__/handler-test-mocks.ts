/**
 * Shared vi.mock preamble for handler-level tests (createRSCHandler with the
 * manifest/middleware/response-route dependency surface stubbed out). Import
 * for side effects BEFORE any import that (transitively) loads ../handler.js:
 *
 *   import "./handler-test-mocks.js";
 *   import { createRSCHandler } from "../handler.js";
 *
 * Mock paths resolve relative to THIS file, so it must stay in
 * src/rsc/__tests__/. Factory bodies live in handler-mock-factories.ts and are
 * pulled via dynamic import INSIDE each factory: vitest hoists these vi.mock
 * calls above this module's own imports, so referencing a static import in the
 * factory argument would hit its binding before initialization.
 *
 * A file that needs a DIFFERENT factory for any of these ids (or needs one of
 * them left unmocked) must NOT import this preamble — it registers only the
 * shared factories it wants, individually, with the same dynamic-import
 * pattern; see handler-telemetry-events.test.ts.
 */
import { vi } from "vitest";

vi.mock("../../route-map-builder.js", async () =>
  (await import("./handler-mock-factories.js")).routeMapBuilderMock(),
);
vi.mock("@vitejs/plugin-rsc/rsc/server", async () =>
  (await import("./handler-mock-factories.js")).pluginRscMock(),
);
vi.mock("@vitejs/plugin-rsc/rsc/client", async () =>
  (await import("./handler-mock-factories.js")).pluginRscMock(),
);
vi.mock("../nonce.js", async () =>
  (await import("./handler-mock-factories.js")).nonceMock(),
);
vi.mock("../manifest-init.js", async () =>
  (await import("./handler-mock-factories.js")).manifestInitMock(),
);
vi.mock("../../router/manifest.js", async () =>
  (await import("./handler-mock-factories.js")).manifestMock(),
);
vi.mock("../../router/middleware.js", async (importOriginal) =>
  (await import("./handler-mock-factories.js")).middlewareMock(importOriginal),
);
vi.mock("../../cache/cache-scope.js", async () =>
  (await import("./handler-mock-factories.js")).cacheScopeMock(),
);
vi.mock("../response-route-handler.js", async () =>
  (await import("./handler-mock-factories.js")).responseRouteMock(),
);
vi.mock("../../router/telemetry.js", async () =>
  (await import("./handler-mock-factories.js")).telemetryMock(),
);
vi.mock("../../router/router-context.js", async () =>
  (await import("./handler-mock-factories.js")).routerContextMock(),
);
