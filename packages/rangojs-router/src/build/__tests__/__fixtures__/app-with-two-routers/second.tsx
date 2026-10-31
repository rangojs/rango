import { createRouter, urls } from "@rangojs/router";

const handler = () => null;
export const secondRouter = createRouter().routes(
  urls(({ path }) => [path("/second", handler, { name: "second" })]),
);
