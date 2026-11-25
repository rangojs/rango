import { urls } from "@rangojs/router";
import { KeepSpikeLayout, KeepSpikePage } from "./keep-spike.client.js";
import {
  KeepSpikeALoader,
  KeepSpikeBLoader,
  KeepSpikeCLoader,
} from "./keep-spike.loaders.js";

// SPIKE (kept pages, part C): the same three pages as server routes under a
// urls() layout, whose Outlet keeps one left page or keeps nothing.

export const keepSpikeServerKeepPatterns = urls(({ layout, path, loader }) => [
  layout(
    () => <KeepSpikeLayout variant="server-keep" keep />,
    () => [
      path(
        "/keep-spike/server-keep/a",
        () => <KeepSpikePage variant="server-keep" page="a" />,
        { name: "ksServerKeepA" },
        () => [loader(KeepSpikeALoader)],
      ),
      path(
        "/keep-spike/server-keep/b",
        () => <KeepSpikePage variant="server-keep" page="b" />,
        { name: "ksServerKeepB" },
        () => [loader(KeepSpikeBLoader)],
      ),
      path(
        "/keep-spike/server-keep/c",
        () => <KeepSpikePage variant="server-keep" page="c" />,
        { name: "ksServerKeepC" },
        () => [loader(KeepSpikeCLoader)],
      ),
    ],
  ),
]);

export const keepSpikeServerPlainPatterns = urls(({ layout, path, loader }) => [
  layout(
    () => <KeepSpikeLayout variant="server-plain" keep={false} />,
    () => [
      path(
        "/keep-spike/server-plain/a",
        () => <KeepSpikePage variant="server-plain" page="a" />,
        { name: "ksServerPlainA" },
        () => [loader(KeepSpikeALoader)],
      ),
      path(
        "/keep-spike/server-plain/b",
        () => <KeepSpikePage variant="server-plain" page="b" />,
        { name: "ksServerPlainB" },
        () => [loader(KeepSpikeBLoader)],
      ),
      path(
        "/keep-spike/server-plain/c",
        () => <KeepSpikePage variant="server-plain" page="c" />,
        { name: "ksServerPlainC" },
        () => [loader(KeepSpikeCLoader)],
      ),
    ],
  ),
]);
