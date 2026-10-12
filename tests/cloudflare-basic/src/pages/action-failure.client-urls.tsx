"use client";

import { clientUrls } from "@rangojs/router/client";
import {
  ActionFailureDataPage,
  ActionFailureThrowPage,
} from "./action-failure.client.js";
import {
  ActionFailureDataLoader,
  ActionFailureThrowLoader,
} from "./action-failure.defs.js";

// A group loader that fails on its rerun after an action (e2e/action-failure.test.ts):
// /throw throws, /data returns the failure as data.
export default clientUrls(({ path, loader }) => [
  path("/throw", ActionFailureThrowPage, { name: "throw" }, () => [
    loader(ActionFailureThrowLoader),
  ]),
  path("/data", ActionFailureDataPage, { name: "data" }, () => [
    loader(ActionFailureDataLoader),
  ]),
]);
