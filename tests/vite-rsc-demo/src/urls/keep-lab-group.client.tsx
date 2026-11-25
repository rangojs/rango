"use client";

import { clientUrls } from "@rangojs/router/client";
import { KeepLabLayout, KeepLabPage } from "./keep-lab.client.js";
import {
  KeepLabALoader,
  KeepLabBLoader,
  KeepLabCLoader,
  KeepLabLayoutLoader,
} from "./keep-lab.loaders.js";

// SPIKE (keep lab, mode 5): the lab's pages as a clientUrls() group whose
// layout keeps the two pages left last.

function Layout() {
  return <KeepLabLayout mode="group" />;
}

function A() {
  return <KeepLabPage mode="group" page="a" />;
}

function B() {
  return <KeepLabPage mode="group" page="b" />;
}

function C() {
  return <KeepLabPage mode="group" page="c" />;
}

export default clientUrls(({ layout, path, loader }) => [
  layout(Layout, () => [
    loader(KeepLabLayoutLoader),
    path("/a", A, { name: "a" }, () => [loader(KeepLabALoader)]),
    path("/b", B, { name: "b" }, () => [loader(KeepLabBLoader)]),
    path("/c", C, { name: "c" }, () => [loader(KeepLabCLoader)]),
  ]),
]);
