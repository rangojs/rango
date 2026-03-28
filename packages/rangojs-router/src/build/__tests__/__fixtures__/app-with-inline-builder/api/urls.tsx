import { urls } from "@rangojs/router";
const handler = () => null;
export const apiUrls = urls(({ path }) => [
  path.json("/health", handler, { name: "health" }),
  path.json("/:id", handler, { name: "detail" }),
]);
