import { urls } from "@rangojs/router";
const handler = () => null;
export const guidesUrls = urls(({ path }) => [
  path("/", handler, { name: "index" }),
  path("/:guideId", handler, { name: "detail" }),
]);
