/**
 * rangoUseClientTransform on a clientUrls() module: the transformed module
 * installs the projection of its own untransformed source under its default
 * export's reference id, and that source resolves the router's client entry
 * as the RSC environment does. prefetch-false-client-urls.rsc-test.tsx and
 * cloudflare-basic's dogfood serve routes through it.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rangoUseClientTransform } from "../vitest.js";

const ID = "/app/src/shop.tsx";
const SOURCE_ID = `${ID}?rango-client-urls-source`;

const CLIENT_URLS_MODULE = `"use client";
import { clientUrls } from "@rangojs/router/client";
export default clientUrls(({ path }) => [path("/", () => null)]);
`;

describe("rangoUseClientTransform: clientUrls() modules", () => {
  it("installs the projection of the module's own source under <id>#default", async () => {
    const result = await rangoUseClientTransform().transform(
      CLIENT_URLS_MODULE,
      ID,
    );
    expect(result?.code).toContain(
      `import * as $$RangoClientUrlsSource from ${JSON.stringify(SOURCE_ID)};`,
    );
    expect(result?.code).toMatch(
      /import \{ installClientUrlsProjection as \$\$rangoInstallClientUrlsProjection \} from "[^"]*\/src\/testing\/internal\/client-urls-projection\.ts";/,
    );
    expect(result?.code).toContain(
      `$$rangoInstallClientUrlsProjection(${JSON.stringify(`${ID}#default`)}, $$RangoClientUrlsSource);`,
    );
  });

  it("leaves a module without a clientUrls() default export as a plain client module", async () => {
    const plugin = rangoUseClientTransform();
    const component = await plugin.transform(
      `"use client";\nexport default function Shop() { return null; }\n`,
      ID,
    );
    expect(component?.code).toContain("registerClientReference");
    expect(component?.code).not.toContain("installClientUrlsProjection");

    const named = await plugin.transform(
      `"use client";\nimport { clientUrls } from "@rangojs/router/client";\nexport const shop = clientUrls(() => []);\n`,
      ID,
    );
    expect(named?.code).not.toContain("installClientUrlsProjection");
  });

  it("does not transform the source import, and resolves its client entry to client.rsc.tsx", async () => {
    const plugin = rangoUseClientTransform();
    const ctx = { resolve: async () => null };
    expect(
      await plugin.transform(CLIENT_URLS_MODULE, SOURCE_ID),
    ).toBeUndefined();
    expect(
      await plugin.resolveId.handler.call(
        ctx,
        "@rangojs/router/client",
        SOURCE_ID,
      ),
    ).toMatch(/\/src\/client\.rsc\.tsx$/);
    expect(
      await plugin.resolveId.handler.call(ctx, "@rangojs/router/client", ID),
    ).toBeUndefined();
    expect(
      await plugin.resolveId.handler.call(ctx, "@rangojs/router", SOURCE_ID),
    ).toBeUndefined();
  });

  it("loads the source's use client project imports and the barrels between as source too, so a component's .use is readable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rango-use-client-source-"));
    try {
      const files: Record<string, string> = {
        // TypeScript and JSX, as on disk.
        "Dashboard.tsx":
          '"use client";\nexport function Dashboard(): unknown {\n  return <p />;\n}\nDashboard.use = (): unknown[] => [];\n',
        "loaders.ts": "export const L = 1;\n",
        "barrel.ts":
          'export * from "./Dashboard.tsx";\nexport { L } from "./loaders.ts";\nexport type { T } from "./types.ts";\n',
        "mixed.ts": 'export * from "./Dashboard.tsx";\nexport const x = 1;\n',
        "node_modules/ui/Button.tsx": '"use client";\nexport const B = 1;\n',
      };
      await mkdir(join(dir, "node_modules/ui"), { recursive: true });
      for (const [name, text] of Object.entries(files)) {
        await writeFile(join(dir, name), text);
      }
      const plugin = rangoUseClientTransform();
      const ctx = {
        resolve: async (source: string) =>
          source === "virtual:x"
            ? { id: "\0virtual:x" }
            : { id: join(dir, source.replace(/^\.\//, "")) },
      };
      const source = `${join(dir, "group.tsx")}?rango-client-urls-source`;
      const resolve = (spec: string, importer = source) =>
        plugin.resolveId.handler.call(ctx, spec, importer);

      expect(await resolve("./Dashboard.tsx")).toBe(
        `${join(dir, "Dashboard.tsx")}?rango-client-urls-source`,
      );
      // Nested: a sourced module's own use client imports.
      expect(
        await resolve(
          "./Dashboard.tsx",
          `${join(dir, "Page.tsx")}?rango-client-urls-source`,
        ),
      ).toBe(`${join(dir, "Dashboard.tsx")}?rango-client-urls-source`);
      // A barrel between them, which holds no state.
      expect(await resolve("./barrel.ts")).toBe(
        `${join(dir, "barrel.ts")}?rango-client-urls-source`,
      );
      // Shared instances: other modules, packages, virtual modules.
      expect(await resolve("./loaders.ts")).toBeUndefined();
      expect(await resolve("./mixed.ts")).toBeUndefined();
      expect(await resolve("./node_modules/ui/Button.tsx")).toBeUndefined();
      expect(await resolve("virtual:x")).toBeUndefined();
      // Outside a group's source nothing changes.
      expect(
        await resolve("./Dashboard.tsx", join(dir, "group.tsx")),
      ).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
