import { urls, type Handler } from "@rangojs/router";
import { ActionLatestCall } from "../components/ActionLatestCall.js";

const ActionLatestPage: Handler = () => (
  <div data-testid="action-latest-page">
    <ActionLatestCall />
  </div>
);

/**
 * Hook lock row A3 (dc-t84): useAction() reports the latest call of an action
 * called twice, the later call returning first. One page, twice: /action-latest
 * without transition(), /action-latest-vt with it, so the action's
 * revalidation commits in a transition.
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
