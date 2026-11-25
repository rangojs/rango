"use client";

import { clientUrls } from "@rangojs/router/client";
import { KeepSpikeLayout, KeepSpikePage } from "./keep-spike.client.js";
import {
  KeepSpikeALoader,
  KeepSpikeBLoader,
  KeepSpikeCLoader,
} from "./keep-spike.loaders.js";

// SPIKE (kept pages, part C): a clientUrls() group whose layout's Outlet
// keeps nothing (the baseline).
const VARIANT = "client-plain";

function Layout() {
  return <KeepSpikeLayout variant={VARIANT} keep={false} />;
}

function A() {
  return <KeepSpikePage variant={VARIANT} page="a" />;
}

function B() {
  return <KeepSpikePage variant={VARIANT} page="b" />;
}

function C() {
  return <KeepSpikePage variant={VARIANT} page="c" />;
}

export default clientUrls(({ layout, path, loader }) => [
  layout(Layout, () => [
    path("/a", A, { name: "a" }, () => [loader(KeepSpikeALoader)]),
    path("/b", B, { name: "b" }, () => [loader(KeepSpikeBLoader)]),
    path("/c", C, { name: "c" }, () => [loader(KeepSpikeCLoader)]),
  ]),
]);
