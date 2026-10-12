"use client";

import { clientUrls } from "@rangojs/router/client";
import { RevalidationGroupPage } from "@/components/RevalidationDemo.js";
import {
  SaveStatusLoader,
  StockLoader,
} from "@/handlers/errors-revalidation/loaders.js";
import { setStockRefreshFailure } from "@/handlers/errors-revalidation/actions.js";

/**
 * /errors/revalidation/group: the clientUrls() variant of the revalidation
 * demo. The stock loader's revalidate() runs on the server and skips the
 * failure toggle, so the next Save is what reruns it.
 */
export default clientUrls(({ path, loader, revalidate }) => [
  path("/", RevalidationGroupPage, { name: "index" }, () => [
    loader(StockLoader, () => [
      revalidate(({ isAction }) =>
        isAction(setStockRefreshFailure) ? false : undefined,
      ),
    ]),
    loader(SaveStatusLoader),
  ]),
]);
