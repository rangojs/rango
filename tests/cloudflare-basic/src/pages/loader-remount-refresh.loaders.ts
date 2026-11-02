import { createLoader } from "@rangojs/router";

// Registered fetchable loader of /loader-remount/{a,b,vt}
// (loader-remount-refresh.tsx): `<page>:<run>`, 400 ms on the server, or
// `params.delay` ms for a slow refresh.
let loaderRemountRun = 0;

export const LoaderRemountLoader = createLoader(
  async (ctx): Promise<{ page: string; run: number }> => {
    await new Promise((resolve) =>
      setTimeout(resolve, Number(ctx.params.delay ?? 400)),
    );
    loaderRemountRun++;
    return {
      page: ctx.pathname.split("/").pop() ?? "",
      run: loaderRemountRun,
    };
  },
  true,
);
