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

describe("manifest initialization", () => {
  beforeEach(() => {
    clearClientUrlProjections();
    clearAllRouterData();
  });

  it("builds every server mount plus a clientUrls include from the installed projection", async () => {
    const clientPatterns = clientUrls(({ path }) => [
      path("/:id", Page, { name: "item" }),
    ]);
    const reference: ClientUrlReference = {
      $$typeof: Symbol.for("react.client.reference"),
      $$id: "/src/projected.urls.tsx#default",
    };
    setClientUrlProjection(
      reference,
      serializeClientUrlPatterns(clientPatterns),
    );

    // One canonical tree containing the clientUrls include; a second server
    // mount keeps the multi-mount rebuild loop covered (still legal for
    // server patterns).
    const primaryTree = urls(({ path, include }) => [
      path("/factory/alpha", Page, { name: "factory.alpha" }),
      include("/projected", reference as unknown as ClientUrlPatterns, {
        name: "projected",
      }),
    ]);
    const secondaryMount = urls(({ path }) => [
      path("/extra", Page, { name: "extra" }),
    ]);

    const router = toInternal(
      createRouter({ id: "manifest-init-multi-mount" })
        .routes(primaryTree)
        .routes(secondaryMount),
    );
    expect(router.__urlpatternMounts).toHaveLength(2);

    // Dev/HMR trie rebuild: the lazy clientUrls include materializes from the
    // projection registry during manifest generation, prefixed by the include.
    await buildRouterTrieFromUrlpatterns(router);

    expect(getRouterManifest(router.id)).toEqual({
      "factory.alpha": "/factory/alpha",
      "projected.item": "/projected/:id",
      extra: "/extra",
    });
  });
});
