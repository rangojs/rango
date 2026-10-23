/**
 * Internal test kit: real router objects from their production constructors,
 * so a unit test exercises the same wiring a request or a browser session
 * does. A test that asserts on a call spies on the kit object (`vi.spyOn`)
 * instead of rebuilding it as a stub. A cache store needs no kit entry: build
 * it with `new MemorySegmentCacheStore()`.
 *
 * Lives under `__tests__`, which `package.json` `files` excludes, so it never
 * ships. The public test primitives are `src/testing/`; this kit is for the
 * router's own tests.
 */
export { makeEventController } from "./event-controller.js";
export { makeNavigationStore } from "./navigation-store.js";
export { makeRequestContext } from "./request-context.js";
