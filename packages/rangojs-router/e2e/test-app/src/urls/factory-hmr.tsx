import { urls } from "@rangojs/router";

/**
 * Factory-generated URL patterns for HMR testing.
 *
 * Because the export is a function call (not a `const x = urls(...)` assignment),
 * the static parser classifies the include() as "factory-call" / unresolvable.
 * These routes only appear after runtime discovery evaluates the module.
 */

function AlphaHandler() {
  return <div data-testid="factory-alpha">Factory Alpha</div>;
}

function BetaHandler() {
  return <div data-testid="factory-beta">Factory Beta</div>;
}

export function createFactoryHmrPatterns() {
  return urls(({ path }) => [
    path("/alpha", AlphaHandler, { name: "alpha" }),
    path("/beta", BetaHandler, { name: "beta" }),
  ]);
}
