// dev-reload-handoff-runner.test.ts: a router module as the runner loads it.
// The hand-off module first, so its import call stack holds this file, as a
// real router module's import of @rangojs/router does.
import * as handoff from "../../../dev-reload-handoff.ts";
import { RouterRegistry } from "../../../router-registry.ts";
import "./slow.ts";

export const router = { id: "runner-reload" };
RouterRegistry.set(router.id, router as never);
export { handoff };
