import {
  createEventController,
  type EventController,
} from "../../browser/event-controller.js";

export interface KitEventControllerOptions {
  /** The committed location: a path or an absolute URL. Default `/`. */
  location?: string;
  /** Route params, applied through `setParams`. */
  params?: Record<string, string>;
  /** Matched segment ids, applied through `setHandleData({}, segmentIds)`. */
  segmentIds?: string[];
}

/**
 * A real `EventController` from the production `createEventController`,
 * seeded through its own setters. Paths resolve against `http://localhost`.
 *
 * Its notifications are scheduled (`setTimeout(0)`), as in the browser: a
 * synchronous test drives a subscriber by calling the listener it captured.
 */
export function makeEventController(
  opts: KitEventControllerOptions = {},
): EventController {
  const controller = createEventController({
    initialLocation: new URL(opts.location ?? "/", "http://localhost"),
  });
  if (opts.params) controller.setParams(opts.params);
  if (opts.segmentIds) controller.setHandleData({}, opts.segmentIds);
  return controller;
}
