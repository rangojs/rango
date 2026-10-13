import { createLoader } from "@rangojs/router";

let statsRuns = 0;
let shellRuns = 0;

/** The page component's `.use` loader: held unless its own action ran. */
export const ComponentUseStatsLoader = createLoader(
  async () => `stats:${++statsRuns}`,
);

export const ComponentUseItemLoader = createLoader(
  async (ctx) => `item:${ctx.params.id}`,
);

/** The layout component's `.use` loader, on the default rules. */
export const ComponentUseShellLoader = createLoader(
  async () => `shell:${++shellRuns}`,
);
