import { urls } from "@rangojs/router";
import { TokenForm } from "./pe-form-state.client.js";

/**
 * A useActionState form whose result is shown once (#1087). A submit before
 * hydration posts natively; the result the server renders must survive the
 * client taking the page over (tests/shared-e2e/src/pe-form-state-scenario.ts).
 */
export const peFormStatePatterns = urls(({ path }) => [
  path("/pe-form-state", () => <TokenForm />, { name: "peFormState" }),
]);
