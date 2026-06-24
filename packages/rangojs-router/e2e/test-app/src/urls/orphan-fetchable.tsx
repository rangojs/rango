import { urls } from "@rangojs/router";
import { OrphanFetchLoaderTest } from "../components/OrphanFetchLoaderTest.js";

/**
 * Route for the orphan fetchable loader reproduction.
 *
 * The route only renders the OrphanFetchLoaderTest client component. It does
 * NOT import OrphanFetchableLoader and does NOT register it via loader(). The
 * loader is therefore reachable only through the client component's import,
 * which keeps it out of the RSC module graph. Production resolution of the
 * _rsc_loader endpoint depends entirely on the build-time loader pre-scan
 * adding it to the runtime manifest.
 */
export const orphanFetchablePatterns = urls(({ path }) => [
  path("/orphan-fetchable", () => <OrphanFetchLoaderTest />, {
    name: "orphanFetchable",
  }),
]);
