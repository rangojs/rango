import { describe, it, expect } from "vitest";
import { generateManifestFull } from "../generate-manifest.js";
import { urls } from "../../urls.js";
import { createClientUrlsWhenRef } from "../../transition-when-ref.js";

/** The shape plugin-rsc's registerClientReference gives a "use client" export. */
function clientRef<T extends Function>(fn: T): T {
  return Object.assign(fn, { $$typeof: Symbol.for("react.client.reference") });
}

const Page = () => null;

describe("generateManifestFull validateTransitionWhen (route discovery)", () => {
  it("fails on a server function, naming the route and pattern", async () => {
    const patterns = urls(({ path, transition }) => [
      path("/product/:id", Page, { name: "product" }, () => [
        transition({ when: () => true }),
      ]),
    ]);
    await expect(
      generateManifestFull(patterns, 0, { validateTransitionWhen: true }),
    ).rejects.toThrow(
      'transition({ when }) on route "product" (/product/:id) is not a client function.',
    );
    // Without the plugin flag (a unit-test project) it is accepted.
    await expect(generateManifestFull(patterns, 0)).resolves.toBeDefined();
  });

  it("accepts a client reference and a clientUrls reference", async () => {
    const patterns = urls(({ path, transition }) => [
      path("/a", Page, { name: "a" }, () => [
        transition({ when: clientRef(() => true) }),
      ]),
      path("/b", Page, { name: "b" }, () => [
        transition({ when: createClientUrlsWhenRef({}, "r1") }),
      ]),
    ]);
    const manifest = await generateManifestFull(patterns, 0, {
      validateTransitionWhen: true,
    });
    expect(manifest.routeManifest).toEqual({ a: "/a", b: "/b" });
  });

  it("checks layouts, the wrapper form and routes in nested includes", async () => {
    const inner = urls(({ path, layout, transition }) => [
      layout(Page, () => [
        transition({ when: () => true }),
        path("/detail", Page, { name: "detail" }),
      ]),
    ]);
    const patterns = urls(({ include }) => [
      include("/shop", inner, { name: "shop" }),
    ]);
    await expect(
      generateManifestFull(patterns, 0, { validateTransitionWhen: true }),
    ).rejects.toThrow('on a layout of route "shop.detail" (/shop/detail)');

    const wrapper = urls(({ path, transition }) => [
      transition({ when: () => true }, () => [path("/w", Page, { name: "w" })]),
    ]);
    await expect(
      generateManifestFull(wrapper, 0, { validateTransitionWhen: true }),
    ).rejects.toThrow('on a layout of route "w" (/w)');
  });
});
