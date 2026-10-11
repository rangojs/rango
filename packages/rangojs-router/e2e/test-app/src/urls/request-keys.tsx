import { urls } from "@rangojs/router";
import { LoaderParamsProbe } from "../components/LoaderParamsProbe.js";
import { FetchableTestLoader } from "../loaders.js";

/**
 * Request-derived names that match an Object.prototype member (#1109).
 * Static segments named `constructor` and `__proto__` match their own routes
 * (the production trie left them out), and /loader-params sends a fetchable
 * loader valid and invalid params (request-keys.test.ts).
 */
export const requestKeyPatterns = urls(({ path }) => [
  path(
    "/constructor",
    () => <p data-testid="request-key-page">constructor route</p>,
    { name: "requestKeyConstructor" },
  ),
  path(
    "/__proto__",
    () => <p data-testid="request-key-page">__proto__ route</p>,
    { name: "requestKeyProto" },
  ),
  path(
    "/loader-params",
    () => <LoaderParamsProbe loader={FetchableTestLoader} />,
    { name: "loaderParams" },
  ),
]);
