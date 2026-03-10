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

export const unnamedIncludeReversePatterns = urls(({ path }) => [
  path(
    "/",
    (ctx) => {
      const localIndex = attemptReverse(
        ctx.reverse,
        ".unnamedIncludeReverseIndex",
      );
      const localDetail = attemptReverse(
        ctx.reverse,
        ".unnamedIncludeReverseDetail",
        { id: "from-index" },
      );
      const globalIndex = attemptReverse(
        ctx.reverse,
        "unnamedIncludeReverseIndex",
      );

      return (
        <div data-testid="unnamed-include-index-page">
          <div data-testid="unnamed-local-index">{localIndex}</div>
          <div data-testid="unnamed-local-detail">{localDetail}</div>
          <div data-testid="unnamed-global-index">{globalIndex}</div>
        </div>
      );
    },
    { name: "unnamedIncludeReverseIndex" },
  ),
  path(
    "/:id",
    (ctx) => {
      const localIndex = attemptReverse(
        ctx.reverse,
        ".unnamedIncludeReverseIndex",
      );
      const globalIndex = attemptReverse(
        ctx.reverse,
        "unnamedIncludeReverseIndex",
      );

      return (
        <div data-testid="unnamed-include-detail-page">
          <div data-testid="unnamed-detail-local-index">{localIndex}</div>
          <div data-testid="unnamed-detail-global-index">{globalIndex}</div>
        </div>
      );
    },
    { name: "unnamedIncludeReverseDetail" },
  ),
]);
