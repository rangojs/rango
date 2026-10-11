/**
 * rangoUseClientTransform on a clientUrls() module: the transformed module
 * installs the projection of its own untransformed source under its default
 * export's reference id, and that source resolves the router's client entry
 * as the RSC environment does. prefetch-false-client-urls.rsc-test.tsx and
 * cloudflare-basic's dogfood serve routes through it.
 */
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
    expect(
      await plugin.transform(CLIENT_URLS_MODULE, SOURCE_ID),
    ).toBeUndefined();
    expect(
      plugin.resolveId.handler("@rangojs/router/client", SOURCE_ID),
    ).toMatch(/\/src\/client\.rsc\.tsx$/);
    expect(
      plugin.resolveId.handler("@rangojs/router/client", ID),
    ).toBeUndefined();
    expect(
      plugin.resolveId.handler("@rangojs/router", SOURCE_ID),
    ).toBeUndefined();
  });
});
