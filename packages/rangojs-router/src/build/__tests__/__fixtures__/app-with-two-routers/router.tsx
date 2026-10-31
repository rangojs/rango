import { createLoader, createRouter, urls } from "@rangojs/router";

export { secondRouter } from "./second.js";

export const HomeLoader = createLoader(async () => "home");

const handler = () => null;
export const router = createRouter().routes(
  urls(({ path, loader }) => [
    path("/", handler, { name: "home" }, () => [loader(HomeLoader)]),
  ]),
);
