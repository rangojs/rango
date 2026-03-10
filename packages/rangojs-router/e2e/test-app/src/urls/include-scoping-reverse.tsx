import { urls } from "@rangojs/router";

function attemptReverse(
  reverse: (
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => string,
  name: string,
  params?: Record<string, string>,
) {
  try {
    return reverse(name, params);
  } catch (error) {
    return `ERROR: ${(error as Error).message}`;
  }
}

// Mounted with { name: "" } — children merge into the parent/global namespace.
// Dot-local reverse still works — falls back to root scope lookup.
export const flattenedIncludePatterns = urls(({ path }) => [
  path(
    "/",
    (ctx) => {
      const globalChild = attemptReverse(ctx.reverse, "flatChild");
      const dotLocalChild = attemptReverse(ctx.reverse, ".flatChild");

      return (
        <div data-testid="flattened-include-page">
          <div data-testid="flat-global-child">{globalChild}</div>
          <div data-testid="flat-dot-local-child">{dotLocalChild}</div>
        </div>
      );
    },
    { name: "flatChild" },
  ),
]);

// Mounted with { name: "ns" } — children should be ns.child globally, .child locally
export const namedIncludePatterns = urls(({ path }) => [
  path(
    "/",
    (ctx) => {
      const globalPrefixed = attemptReverse(ctx.reverse, "ns.nsChild");
      const dotLocalChild = attemptReverse(ctx.reverse, ".nsChild");
      const globalBare = attemptReverse(ctx.reverse, "nsChild");

      return (
        <div data-testid="named-include-page">
          <div data-testid="ns-global-prefixed">{globalPrefixed}</div>
          <div data-testid="ns-dot-local">{dotLocalChild}</div>
          <div data-testid="ns-global-bare">{globalBare}</div>
        </div>
      );
    },
    { name: "nsChild" },
  ),
]);
