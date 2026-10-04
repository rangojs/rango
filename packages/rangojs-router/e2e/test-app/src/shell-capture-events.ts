import type { ShellCaptureDebugEvent } from "@rangojs/router";

/**
 * Test-only sink for the router's `debugShellCapture` events, read back by the
 * /shell-cache/__capture-events fixture endpoint so a suite can wait for a
 * capture's actual outcome instead of a timing gap. Bounded (the oldest events
 * drop) so a long e2e run cannot grow it without limit.
 */
const MAX_EVENTS = 500;
const events: ShellCaptureDebugEvent[] = [];

export function recordShellCaptureEvent(event: ShellCaptureDebugEvent): void {
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

/** Events for the shell whose key ends with `${pathAndSearch}:shell`. */
export function shellCaptureEventsFor(
  pathAndSearch: string,
): ShellCaptureDebugEvent[] {
  const suffix = `${pathAndSearch}:shell`;
  return events.filter((event) => event.key.endsWith(suffix));
}
