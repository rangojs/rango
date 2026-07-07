import { createLoader, cookies } from "@rangojs/router";

// ppr header-write guard fixtures (issue #713).

// LOADER cookie write on a ppr route — the unified guard throws (headers
// flush with the shell before loaders settle; the write is a dead letter on
// HITs). Consumed by the /ppr-header-guard/loader route's handler.
export const CfPhgCookieWriterLoader = createLoader(
  async (): Promise<{
    wrote: boolean;
  }> => {
    cookies().set("cf-phg-loader", "should-never-apply", { path: "/" });
    return { wrote: true };
  },
);

// Live hole for the mw-live and basket shells; seq proves the loader re-runs
// per request while the shell serves from KV.
let cfPhgHoleSeq = 0;
export const CfPhgHoleLoader = createLoader(
  async (): Promise<{
    seq: number;
  }> => {
    cfPhgHoleSeq += 1;
    return { seq: cfPhgHoleSeq };
  },
);
