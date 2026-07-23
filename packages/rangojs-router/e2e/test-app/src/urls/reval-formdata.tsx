import { urls } from "@rangojs/router";
import { RevalFormDataProbe } from "../components/RevalFormDataProbe.js";
import { RevalFormDataLoader } from "../loaders.js";

/**
 * e2e fixture for shouldRevalidate({ formData }) parity (C2). The probe loader
 * re-runs only when the form action's FormData reaches the revalidate predicate
 * with the clean `reload` key. The predicate returns a HARD boolean from
 * formData, overriding the loader's permissive POST default — so a `reload=no`
 * submit must NOT re-run, and a `reload=yes` submit MUST re-run. This isolates
 * the formData channel: under the bug formData is undefined / Flight-encoded, so
 * `reload=yes` would not re-run. Exercised in both dev and production, JS + PE.
 */
export const revalFormDataPatterns = urls(({ path, loader, revalidate }) => [
  path(
    "/",
    () => (
      <div data-testid="reval-formdata-page">
        <RevalFormDataProbe />
      </div>
    ),
    { name: "index" },
    () => [
      loader(RevalFormDataLoader, () => [
        revalidate(({ formData }) => formData?.get("reload") === "yes"),
      ]),
    ],
  ),
]);
