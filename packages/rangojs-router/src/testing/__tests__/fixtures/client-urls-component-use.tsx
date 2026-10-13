"use client";

/**
 * A clientUrls() group whose components carry their own items
 * (client-urls-component-use-page.tsx): the group itself declares none.
 */
import { clientUrls } from "../../../client-urls/client-urls.js";
import type { ClientUrlPatterns } from "../../../client-urls/types.js";
import { Dashboard, Shell } from "./client-urls-component-use-page.js";

function Plain(): null {
  return null;
}

const definition: ClientUrlPatterns = clientUrls(({ layout, path }) => [
  layout(Shell, () => [
    path("/", Dashboard, { name: "index" }),
    path("/plain", Plain, { name: "plain" }),
  ]),
]);

export default definition;
