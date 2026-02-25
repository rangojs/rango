import { urls } from "@rangojs/router";
import {
  PrerenderCtxTest,
  PrerenderCtxLayout,
  PrerenderCtxSidebar,
} from "./prerender-ctx-handler.js";

export const prerenderCtxPatterns = urls(({ path, layout, parallel }) => [
  path("/:slug", PrerenderCtxTest, { name: "detail" }, () => [
    layout(PrerenderCtxLayout, () => [
      parallel({ "@ctx-sidebar": PrerenderCtxSidebar }),
    ]),
  ]),
]);
