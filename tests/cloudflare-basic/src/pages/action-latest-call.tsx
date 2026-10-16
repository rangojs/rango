import { urls, type Handler } from "@rangojs/router";
import { ActionLatestCall } from "../components/ActionLatestCall.js";

const ActionLatestPage: Handler = () => (
  <div data-testid="action-latest-page">
    <ActionLatestCall />
  </div>
);

/**
 * Cloudflare-basic mirror of the router e2e app's /action-latest* fixture
 * (urls/action-latest-call.tsx). Hook lock row A3: useAction() reports the
 * latest call of an action called twice, the later call returning first.
 * /action-latest has no transition(); /action-latest-vt has one, so the
 * action's revalidation commits in a transition.
 */
export const actionLatestCallPatterns = urls(({ path, transition }) => [
  path("/action-latest", ActionLatestPage, { name: "actionLatest" }),
  path(
    "/action-latest-vt",
    ActionLatestPage,
    { name: "actionLatestVt" },
    () => [transition()],
  ),
]);
