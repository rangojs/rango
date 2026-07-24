import { beforeEach, describe, expect, it } from "vitest";
import { clientUrls } from "../../client-urls/client-urls.js";
import {
  clearClientUrlProjections,
  serializeClientUrlPatterns,
  setClientUrlProjection,
  type ClientUrlReference,
} from "../../client-urls/server-projection.js";
import type { ClientUrlPatterns } from "../../client-urls/types.js";
import {
  clearAllRouterData,
  getRouterManifest,
} from "../../route-map-builder.js";
import { createRouter, toInternal } from "../../router.js";
import { urls } from "../../urls.js";
import { buildRouterTrieFromUrlpatterns } from "../manifest-init.js";

function Page(): null {
  return null;
}

function createFactoryPatterns() {
  return urls(({ path }) => [
    path("/factory/alpha", Page, { name: "factory.alpha" }),
  ]);
}

describe("multi-mount manifest initialization", () => {
  beforeEach(() => {
    clearClientUrlProjections();
    clearAllRouterData();
  });

  it("tracks a projected client mount only after installation and builds both mounts", async () => {
    const factoryPatterns = createFactoryPatterns();
    const clientPatterns = clientUrls(({ path }) => [
      path("/projected/:id", Page, { name: "projected.item" }),
    ]);
    const reference: ClientUrlReference = {
      $$typeof: Symbol.for("react.client.reference"),
      $$id: "/src/projected.urls.tsx#default",
    };
    const router = toInternal(
      createRouter({ id: "manifest-init-multi-mount" }).routes(factoryPatterns),
    );

    (router.routes as (patterns: ClientUrlPatterns) => unknown)(
      reference as unknown as ClientUrlPatterns,
    );

    expect(router.__urlpatternMounts).toEqual([
      { patterns: factoryPatterns, mountIndex: 0 },
    ]);
    expect(router.urlpatterns).toBe(factoryPatterns);

    setClientUrlProjection(
      reference,
      serializeClientUrlPatterns(clientPatterns),
    );

    expect(router.__urlpatternMounts).toHaveLength(2);
    expect(router.__urlpatternMounts.map((mount) => mount.mountIndex)).toEqual([
      0, 1,
    ]);
    expect(router.__urlpatternMounts[0]?.patterns).toBe(factoryPatterns);
    expect(router.__urlpatternMounts[1]?.patterns).toBe(router.urlpatterns);

    await buildRouterTrieFromUrlpatterns(router);

    expect(getRouterManifest(router.id)).toEqual({
      "factory.alpha": "/factory/alpha",
      "projected.item": "/projected/:id",
    });
  });
});
