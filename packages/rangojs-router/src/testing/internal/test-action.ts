import * as RSDServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import { registerServerModule } from "./server-modules.js";

/**
 * Register `action` under its reference id, `<module id>#<export name>`,
 * tagged as a server reference like a built "use server" export so it keeps
 * its `$$id`, where the plugin-rsc stub's decodeAction / loadServerAction
 * resolve it. `primitive` names the caller in the error for a malformed id.
 * Loads the react-server build: callers run under the react-server condition.
 */
export function registerTestAction(
  action: (...args: any[]) => unknown,
  id: string,
  primitive: string,
): void {
  const [moduleId, name] = id.split("#");
  if (!moduleId || !name) {
    throw new Error(
      `${primitive}: id must be "<module id>#<export name>", received ${JSON.stringify(id)}`,
    );
  }
  registerServerModule(moduleId, {
    [name]: RSDServer.registerServerReference(action, moduleId, name),
  });
}
