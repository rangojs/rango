import { urls } from "@rangojs/router";
import { IsActionProbe } from "../components/IsActionProbe.js";
import { IsActionProbeLoader } from "../loaders.js";
import { isActionTargetAction } from "../actions.js";

/**
 * e2e fixture for ctx.isAction(). The probe loader re-runs only when the target
 * action fired: isAction() returns a raw boolean, so the target yields a hard
 * `true` (re-run) and the decoy a hard `false` (skip, overriding the loader's
 * permissive POST default). Exercised in both dev and production.
 */
export const isActionPatterns = urls(({ path, loader, revalidate }) => [
  path(
    "/",
    () => (
      <div data-testid="is-action-page">
        <IsActionProbe />
      </div>
    ),
    { name: "index" },
    () => [
      loader(IsActionProbeLoader, () => [
        revalidate(({ isAction }) => isAction(isActionTargetAction)),
      ]),
    ],
  ),
]);
