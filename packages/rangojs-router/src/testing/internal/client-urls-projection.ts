import {
  projectClientUrlsModule,
  setClientUrlProjection,
} from "../../client-urls/server-projection.js";

/**
 * Install the projection of a `"use client"` clientUrls() module under its
 * client reference id, as discovery installs it for an app
 * (discoverClientUrlProjections in vite/discovery/client-urls-projection.ts):
 * the same projection step, into the same registry include() materializes
 * from. rangoUseClientTransform (testing/vitest.ts) appends a call to every
 * such module, passing the module's own source evaluated without the
 * transform, so a router under test mounts the group with no setup.
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
  setClientUrlProjection(referenceId, projection);
}
