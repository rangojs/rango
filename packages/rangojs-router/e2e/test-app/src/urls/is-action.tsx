import { urls } from "@rangojs/router";
import { IsActionProbe } from "../components/IsActionProbe.js";
import { IsActionProbeLoader, IsActionAnyLoader } from "../loaders.js";
import { isActionTargetAction } from "../actions.js";

/**
 * e2e fixture for ctx.isAction(). The probe loader re-runs only when the target
 * action fired: isAction(target) returns a raw boolean, so the target yields a
 * hard `true` (re-run) and the decoy a hard `false` (skip, overriding the
 * loader's permissive POST default). The "any" loader is gated by BARE
 * `isAction()` (no argument), so it re-runs on ANY action — target or decoy —
 * proving the bare form means "is this request an action at all?". Exercised in
 * both dev and production.
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
      loader(IsActionAnyLoader, () => [
        revalidate(({ isAction }) => isAction()),
      ]),
    ],
  ),
]);
