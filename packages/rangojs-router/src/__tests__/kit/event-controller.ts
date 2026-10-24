import {
  createEventController,
  type EventController,
} from "../../browser/event-controller.js";

const DEFAULT_URL = "http://localhost/";

interface KitEventControllerOptions {
  /** The committed location; a path resolves against http://localhost/. */
  url?: string | URL;
  /** Route params, as a commit's setParams writes them. */
  params?: Record<string, string>;
  /** Matched segment ids, as a commit's setHandleData writes them. */
  matched?: string[];
}

/**
 * An EventController from createEventController, holding the committed
 * location, params and matched segments a test starts from. The seeding
 * notifications are flushed before it returns, so a listener a test
 * subscribes afterwards hears only what the test changes.
 */
export function makeEventController(
  options: KitEventControllerOptions = {},
): EventController {
  const controller = createEventController({
    initialLocation: new URL(options.url ?? DEFAULT_URL, DEFAULT_URL),
  });
  if (options.params) controller.setParams(options.params);
  if (options.matched) controller.setHandleData({}, options.matched);
  controller.flushRouteState();
  return controller;
}
