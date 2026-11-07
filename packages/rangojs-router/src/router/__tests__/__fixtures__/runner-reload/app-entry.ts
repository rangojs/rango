// dev-reload-handoff-runner.test.ts: a generated Node RSC entry as the runner
// loads it (getVirtualEntryRSC): the hand-off wraps its handler, a
// slow import stands for the bootstrap and router modules, and the
// registration is its last statement.
import * as handoff from "../../../dev-reload-handoff.ts";
import "./slow.ts";

interface EntryState {
  realms: number;
  gate?: Promise<void>;
}

const state = globalThis as { __rangoRunnerReloadEntry?: EntryState };
const entryState = (state.__rangoRunnerReloadEntry ??= { realms: 0 });
const realm = ++entryState.realms;

export function handler(request: Request): Promise<Response> {
  return handoff.serveEntryAcrossRunnerReload(request, undefined, handler, () =>
    serve(request),
  );
}

async function serve(request: Request): Promise<Response> {
  await entryState.gate;
  return new Response(`${request.method} realm ${realm}`);
}

export { handoff };

handoff.registerEntryHandler(handler);
