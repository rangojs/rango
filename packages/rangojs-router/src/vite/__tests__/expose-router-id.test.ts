import { describe, it, expect } from "vitest";
import { exposeRouterId } from "../expose-internal-ids.ts";

function createPlugin() {
  const plugin = exposeRouterId();
  return plugin as typeof plugin & {
    configResolved: (config: any) => void;
    transform: (code: string, id: string) => any;
  };
}

describe("exposeRouterId", () => {
  it("injects router id when createRouter is imported with alias", () => {
    const plugin = createPlugin();
    plugin.configResolved({ root: "/project" });

    const code = `import { createRouter as cr } from "@rangojs/router";
const router = cr({});
`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeDefined();
    expect(result.code).toContain("$$id");
    expect(result.code).toContain("$$routeNames");
  });

  it("returns null when createRouter is not imported from @rangojs/router", () => {
    const plugin = createPlugin();
    plugin.configResolved({ root: "/project" });

    const code = `const router = createRouter({});`;
    const result = plugin.transform(code, "/project/src/router.tsx");
    expect(result).toBeNull();
  });
});
