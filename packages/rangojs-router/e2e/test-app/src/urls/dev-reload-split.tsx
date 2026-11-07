import { urls } from "@rangojs/router";

/**
 * e2e/dev-reload-handoff.test.ts: the handler loads a probe that, in that
 * suite's dev server, asks for an RSC runner full reload and resumes after the
 * runner's clear. What the handler imports next is then a fresh module copy,
 * whose request context is not this request's, as with a reload that lands
 * while a request loads a module nothing imported before.
 */
export const devReloadSplitPatterns = urls(({ path }) => [
  path(
    "/",
    async () => {
      await import("../dev-reload-split-probe.js");
      const { requestPathname } = await import("../dev-reload-split-read.js");
      return <p data-testid="dev-reload-split">{requestPathname()}</p>;
    },
    { name: "index" },
  ),
]);
