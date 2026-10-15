import { createLoader } from "@rangojs/router";

// Issue #1179 fixture (e2e/ppr-include-bake.test.ts): the store layout's
// `ssr: false` loader. Every run is numbered, so a shell HIT that serves the
// value the capture baked shows the same run on every HIT.
let runs = 0;

export interface PprIncludeChromeData {
  run: string;
}

export const PprIncludeChromeLoader = createLoader(
  async (): Promise<PprIncludeChromeData> => {
    runs += 1;
    return { run: `chrome run ${runs}` };
  },
);
