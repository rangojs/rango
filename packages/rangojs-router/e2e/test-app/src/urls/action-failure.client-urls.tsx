"use client";

import { clientUrls } from "@rangojs/router/client";
import {
  ActionFailureDataPage,
  ActionFailureLoading,
  ActionFailureThrowPage,
} from "./action-failure.client.js";
import {
  ActionFailureDataLoader,
  ActionFailureRevisionLoader,
  ActionFailureThrowLoader,
} from "./action-failure.defs.js";

// A group loader that fails on its rerun after an action (action-failure.test.ts):
// /throw throws, /throw-loading throws under a loading(), /data returns the
// failure as data.
export default clientUrls(({ path, loader, loading }) => [
  path("/throw", ActionFailureThrowPage, { name: "throw" }, () => [
    loader(ActionFailureThrowLoader),
    loader(ActionFailureRevisionLoader),
  ]),
  path(
    "/throw-loading",
    ActionFailureThrowPage,
    { name: "throwLoading" },
    () => [
      loader(ActionFailureThrowLoader),
      loader(ActionFailureRevisionLoader),
      loading(<ActionFailureLoading />),
    ],
  ),
  path("/data", ActionFailureDataPage, { name: "data" }, () => [
    loader(ActionFailureDataLoader),
  ]),
]);
