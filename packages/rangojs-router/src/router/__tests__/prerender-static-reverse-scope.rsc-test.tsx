/**
 * A baked Static() layout hands its ctx to a server component that React
 * renders AFTER the handler returned, and that component's `ctx.reverse(".name")`
 * resolves in the same module: the scope rides the ctx object (withReverseScope,
 * router/handler-context.ts), not the call frame, so the bake matches the live
 * segment. Real Flight here, since the mocked codec in
 * prerender-static-reverse-scope.test.ts never renders components.
 *
 * Before: the bake passed the def's include prefix as a route name, so the
 * project module's layout and its child both baked the account module's
 * "/acme/settings".
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc/server", async () => {
  const RSD =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge");
  // Resolves any "use client" reference (the router's implicit layouts render
  // the client Outlet): `$$id` is `${id}#${name}`.
  const clientManifest = new Proxy(
    {},
    {
      get: (_target, key) =>
        typeof key === "string"
          ? { id: key.split("#")[0], chunks: [], name: key.split("#")[1] }
          : undefined,
    },
  );
  return {
    createTemporaryReferenceSet: () => new WeakMap(),
    renderToReadableStream: (value: unknown, options?: object) =>
      RSD.renderToReadableStream(value, clientManifest, options),
  };
});
vi.mock("@vitejs/plugin-rsc/rsc/client", async () => {
  await import("../../testing/internal/flight-client-globals.js");
  const { createFromReadableStream } =
    await import("@vitejs/plugin-rsc/react/browser");
  return {
    createFromReadableStream: (stream: ReadableStream<Uint8Array>) =>
      createFromReadableStream(stream),
  };
});

import type { StaticBuildContext } from "../../prerender.js";
import { urls } from "../../urls/urls-function.js";
import { Static } from "../../static-handler.js";
import { createRouter } from "../../router.js";
import type { RangoInternal } from "../../router/router-interfaces.js";
import { generateManifestFull } from "../../build/generate-manifest.js";

/** A server component the layout hands its ctx to; renders after the handler. */
async function ChildLink({ ctx }: { ctx: StaticBuildContext }) {
  await Promise.resolve();
  return <p>{`child:${ctx.reverse(".settings")}`}</p>;
}

const projectLayout = Static((ctx) => (
  <div>
    <p>{`layout:${ctx.reverse(".settings")}`}</p>
    <ChildLink ctx={ctx} />
  </div>
));

const projectPatterns = urls(({ path, layout }) => [
  layout(projectLayout, () => [
    path("/settings", () => <p>project settings</p>, { name: "settings" }),
  ]),
]);

const patterns = urls(({ path, include }) => [
  path("/", () => <p>home</p>, { name: "home" }),
  include(
    "/acme",
    urls(({ path, include }) => [
      path("/settings", () => <p>account settings</p>, { name: "settings" }),
      include("/web", projectPatterns, { name: "srsProject" }),
    ]),
    { name: "srsAccount" },
  ),
]);

const router = createRouter({
  id: "static-reverse-scope-flight",
  // The generated named-routes seed a build's reverse map starts from.
  $$routeNames: {
    home: "/",
    "srsAccount.settings": "/acme/settings",
    "srsAccount.srsProject.settings": "/acme/web/settings",
  },
}).routes(patterns) as unknown as RangoInternal<any, any>;

describe("Static() bake: the scoped ctx a component renders with", () => {
  beforeAll(async () => {
    await generateManifestFull(patterns, 0, {
      routerId: "static-reverse-scope-flight",
    });
  });

  it("resolves the component's dot name in the layout's own module", async () => {
    const def = projectLayout as any;
    const result = await router.renderStaticSegment(
      def.handler,
      def.$$id,
      def.$$routeName,
      undefined,
      undefined,
      def.$$reverseScope,
    );
    const encoded = result?.encoded ?? "";
    expect(encoded).toContain("layout:/acme/web/settings");
    expect(encoded).toContain("child:/acme/web/settings");
  });
});
