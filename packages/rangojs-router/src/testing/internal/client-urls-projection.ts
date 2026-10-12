import {
  projectClientUrlsModule,
  setClientUrlProjection,
  type ClientUrlProjection,
} from "../../client-urls/server-projection.js";
import { isHoistedRevalidateRef } from "../../client-urls/hoisted-revalidate.js";
import { registerClientUrlRevalidators } from "../../client-urls/revalidate-registry.js";
import type { ClientUrlPatterns } from "../../client-urls/types.js";
import type { ShouldRevalidateFn } from "../../types.js";

/**
 * Install the projection of a `"use client"` clientUrls() module under its
 * client reference id, as discovery installs it for an app
 * (discoverClientUrlProjections in vite/discovery/client-urls-projection.ts):
 * the same projection step, into the same registry include() materializes
 * from. rangoUseClientTransform (testing/vitest.ts) appends a call to every
 * such module, passing the module's own source evaluated without the
 * transform, so a router under test mounts the group with no setup.
 *
 * A Vitest project runs no hoist plugin, so the source's revalidate()
 * predicates are plain functions. Each is registered under a key named for
 * its reference, route or intercept, and loader, as the plugin's generated
 * module registers its own, and the projection carries the keys:
 * materialization attaches them and the server runs them, as in an app.
 */
export function installClientUrlsProjection(
  referenceId: string,
  source: Readonly<Record<string, unknown>>,
): void {
  const projection = projectClientUrlsModule(source);
  if (!projection) {
    throw new Error(
      `Cannot install the client URL projection for reference "${referenceId}": ` +
        'the module default export must be created by clientUrls() and have __brand === "client-urls"',
    );
  }
  setClientUrlProjection(
    referenceId,
    withRevalidateKeys(
      referenceId,
      source.default as ClientUrlPatterns,
      projection,
    ),
  );
}

function withRevalidateKeys(
  referenceId: string,
  definition: ClientUrlPatterns,
  projection: ClientUrlProjection,
): ClientUrlProjection {
  const fns: Record<string, ShouldRevalidateFn<any, any>> = {};
  // A route's or an intercept's loaders, keyed under `owner`.
  const withKeys = <T extends object>(
    projected: T,
    owner: string,
    loaders: ClientUrlPatterns["routes"][number]["loaders"] | undefined,
  ): T => {
    const loaderRevalidate = (loaders ?? []).map(
      ({ revalidate }, loaderIndex) =>
        revalidate.map((entry, index) => {
          if (isHoistedRevalidateRef(entry)) return entry.$$rangoRevalidate;
          const key = `${referenceId}:${owner}:${loaderIndex}:${index}`;
          fns[key] = entry;
          return key;
        }),
    );
    return loaderRevalidate.some((keys) => keys.length > 0)
      ? { ...projected, loaderRevalidate }
      : projected;
  };
  const routes = projection.routes.map((route) =>
    withKeys(
      route,
      route.id,
      definition.routes.find(({ id }) => id === route.id)?.loaders,
    ),
  );
  const intercepts = projection.intercepts?.map((intercept, index) =>
    withKeys(
      intercept,
      `intercept${index}`,
      definition.intercepts[index]?.loaders,
    ),
  );
  registerClientUrlRevalidators(fns);
  return { ...projection, routes, ...(intercepts && { intercepts }) };
}
