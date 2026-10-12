"use client";

/**
 * A clientUrls() group as an app writes one: the default export of a
 * "use client" module. On the server it is a client reference, and
 * rangoUseClientTransform installs its projection, as discovery does.
 */
import { clientUrls } from "../../../client-urls/client-urls.js";
import type { ClientUrlPatterns } from "../../../client-urls/types.js";
import {
  DetailLoader,
  ItemLoader,
  ModalLoader,
  NoteLoader,
  PriceLoader,
  ReviewsLoader,
  ShellLoader,
} from "./prefetch-false-client-urls-data.js";

function CuHome(): null {
  return null;
}
function CuLoaderPage(): null {
  return null;
}
function CuItem(): null {
  return null;
}
function CuLayout(): null {
  return null;
}
function CuInLayout(): null {
  return null;
}
function CuDetail(): null {
  return null;
}
function CuModal(): null {
  return null;
}
function CuNote(): null {
  return null;
}

const group: ClientUrlPatterns = clientUrls(
  ({ path, layout, loader, loading, intercept, revalidate }) => [
    path("/", CuHome, { name: "index" }),
    path("/loader", CuLoaderPage, { name: "loader" }, () => [
      loader(PriceLoader),
      loader(ReviewsLoader, { prefetch: false }),
      loading("cu-loading"),
    ]),
    path("/item/:id", CuItem, { name: "item" }, () => [
      loader(ItemLoader, { prefetch: false }),
    ]),
    layout(CuLayout, () => [
      loader(ShellLoader, { prefetch: false }),
      path("/in-layout", CuInLayout, { name: "inLayout" }),
    ]),
    path("/detail/:id", CuDetail, { name: "detail" }, () => [
      loader(DetailLoader),
    ]),
    intercept("@modal", ".detail", CuModal, () => [
      loader(ModalLoader, { prefetch: false }),
    ]),
    // An intercept loader's revalidate() runs on the server, as a route's.
    path("/note/:id", CuNote, { name: "note" }),
    intercept("@modal", ".note", CuModal, () => [
      loader(NoteLoader, () => [
        revalidate(({ actionResult }) =>
          actionResult === undefined ? undefined : actionResult === "saved",
        ),
      ]),
    ]),
  ],
);

export default group;
