import { describe, expect, it } from "vitest";
import { createVersionInjectorPlugin } from "../plugins/version-injector.js";

function initPlugin(command: "serve" | "build" = "build") {
  const plugin = createVersionInjectorPlugin(
    "src/worker.rsc.tsx",
  ) as ReturnType<typeof createVersionInjectorPlugin> & {
    configResolved: (config: any) => void;
    transform: (code: string, id: string) => any;
  };

  plugin.configResolved({ root: "/project", command });
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
      /^import "virtual:rsc-router\/routes-manifest";\nimport "virtual:rsc-router\/loader-manifest";\nimport \{ router \} from "\.\/router\.js";/,
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
      /^\/\/\/ <reference types="@cloudflare\/workers-types" \/>\n\nimport "virtual:rsc-router\/routes-manifest";\nimport "virtual:rsc-router\/loader-manifest";\nimport \{ router \} from "\.\/router\.js";/,
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
      /^import "virtual:rsc-router\/routes-manifest";\nimport "virtual:rsc-router\/loader-manifest";\nimport \{ VERSION \} from "@rangojs\/router:version";/,
    );
    expect(result.code).toContain("createRSCHandler({\n  version: VERSION,");
  });

  // Regression: a custom worker entry must also import the loader manifest, not
  // only the routes manifest. Without it, setLoaderImports() is never bundled
  // into the worker, so a fetchable loader that is reachable only through a
  // client component (never registered via loader(), never imported by the
  // server graph) cannot be resolved by the _rsc_loader endpoint in production.
  // The virtual RSC entry imports the loader manifest itself; a hand-written
  // worker.rsc.tsx does not, which is why this injection is required.
  it("injects the loader manifest import for fetchable loader resolution", () => {
    const plugin = initPlugin();
    const code = `import { router } from "./router.js";

export default {
  fetch(request: Request) {
    return router.fetch(request);
  },
};
`;

    const result = plugin.transform(code, "/project/src/worker.rsc.tsx");

    // Injected exactly once, immediately after the routes manifest import.
    expect(
      result.code.match(/import "virtual:rsc-router\/loader-manifest";/g),
    ).toHaveLength(1);
    expect(result.code).toMatch(
      /import "virtual:rsc-router\/routes-manifest";\nimport "virtual:rsc-router\/loader-manifest";/,
    );
  });

  it("injects the diagnostic bridge only into development workers", () => {
    const code = `export default { fetch() { return new Response("ok"); } };`;
    const development = initPlugin("serve").transform(
      code,
      "/project/src/worker.rsc.tsx",
    );
    const production = initPlugin("build").transform(
      code,
      "/project/src/worker.rsc.tsx",
    );

    expect(development.code).toContain(
      'import "@rangojs/router/internal/dev-diagnostics";',
    );
    expect(production.code).not.toContain("dev-diagnostics");
  });
});
