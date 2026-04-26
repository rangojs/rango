import { describe, expect, it } from "vitest";
import { createVersionInjectorPlugin } from "../plugins/version-injector.js";

function initPlugin() {
  const plugin = createVersionInjectorPlugin(
    "src/worker.rsc.tsx",
  ) as ReturnType<typeof createVersionInjectorPlugin> & {
    configResolved: (config: any) => void;
    transform: (code: string, id: string) => any;
  };

  plugin.configResolved({ root: "/project" });
  return plugin;
}

describe("createVersionInjectorPlugin", () => {
  it("prepends the routes manifest import even when the entry already imports it later", () => {
    const plugin = initPlugin();
    const code = `import { router } from "./router.js";
import type { AppBindings } from "./env.js";
import "virtual:rsc-router/routes-manifest";

export default {
  fetch(request: Request, env: AppBindings, ctx: ExecutionContext) {
    return router.fetch(request, { env, ctx });
  },
};
`;

    const result = plugin.transform(code, "/project/src/worker.rsc.tsx");

    expect(result?.code).toMatch(
      /^import "virtual:rsc-router\/routes-manifest";\nimport \{ router \} from "\.\/router\.js";/,
    );
    expect(
      result.code.match(/import "virtual:rsc-router\/routes-manifest";/g),
    ).toHaveLength(2);
  });

  it("inserts imports after leading triple-slash reference directives", () => {
    const plugin = initPlugin();
    const code = `/// <reference types="@cloudflare/workers-types" />

import { router } from "./router.js";

export default {
  fetch(request: Request) {
    return router.fetch(request);
  },
};
`;

    const result = plugin.transform(code, "/project/src/worker.rsc.tsx");

    expect(result?.code).toMatch(
      /^\/\/\/ <reference types="@cloudflare\/workers-types" \/>\n\nimport "virtual:rsc-router\/routes-manifest";\nimport \{ router \} from "\.\/router\.js";/,
    );
  });

  it("keeps injected VERSION import after the manifest gate", () => {
    const plugin = initPlugin();
    const code = `import { createRSCHandler } from "@rangojs/router/rsc";
import { router } from "./router.js";

export default createRSCHandler({
  router,
});
`;

    const result = plugin.transform(code, "/project/src/worker.rsc.tsx");

    expect(result?.code).toMatch(
      /^import "virtual:rsc-router\/routes-manifest";\nimport \{ VERSION \} from "@rangojs\/router:version";/,
    );
    expect(result.code).toContain("createRSCHandler({\n  version: VERSION,");
  });
});
