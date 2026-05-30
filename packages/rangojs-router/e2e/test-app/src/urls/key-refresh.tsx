import { urls, loader } from "@rangojs/router";
import { KeyRefreshRegisteredLoader } from "../loaders.js";
import {
  KeyRefreshWidget,
  KeyRefreshGroupButton,
} from "../components/KeyRefreshWidget.js";
import { KeyRefreshErrorWidget } from "../components/KeyRefreshErrorWidget.js";
import { KeyRefreshRegisteredWidget } from "../components/KeyRefreshRegisteredWidget.js";
import { KeyRefreshParamWidget } from "../components/KeyRefreshParamWidget.js";
import { KeyRefreshLifeLayout } from "../components/KeyRefreshLifeLayout.js";
import {
  KeyRefreshGroupPage,
  KeyRefreshMultiTagPage,
} from "../components/KeyRefreshGroup.js";

/**
 * Scenarios for the client refresh `key` option on useLoader / useFetchLoader.
 *
 * /key-refresh-shared      — unregistered loader, two readers sharing one key;
 *                            a load() from the originator refreshes the group.
 * /key-refresh-distinct    — unregistered loader, two readers with different
 *                            keys; a load() stays within its own key.
 * /key-refresh-nokey       — unregistered loader, no key; loads stay local
 *                            (today's behavior, unchanged).
 * /key-refresh-error       — unregistered loader, keyed group, throwOnError;
 *                            only the originator throws, the sibling exposes
 *                            the shared error without throwing.
 * /key-refresh-registered  — registered loader; keyed readers share a refetch,
 *                            a no-key reader keeps the seeded value.
 * /key-refresh-life/{a,b}  — bucket lifecycle: a persistent keyed reader in the
 *                            layout survives navigation; a route-scoped keyed
 *                            reader resets when it unmounts.
 * /key-refresh-group       — cross-loader group: useRefreshLoaders() refreshes
 *                            two different loaders tagged with one refreshGroup.
 * /key-refresh-multitag    — multi-tag: each read is tagged into several groups;
 *                            a fine tag refreshes a subset, the coarse tag or a
 *                            union argument refreshes the whole set.
 */
export const keyRefreshPatterns = urls(({ path, layout }) => [
  path(
    "/key-refresh-shared",
    () => (
      <div data-testid="key-refresh-shared-page">
        <h1>Key Refresh — Shared</h1>
        <KeyRefreshWidget id="A" loaderKey="grp" />
        <KeyRefreshWidget id="B" loaderKey="grp" withButton={false} />
      </div>
    ),
    { name: "keyRefreshShared" },
  ),
  path(
    "/key-refresh-distinct",
    () => (
      <div data-testid="key-refresh-distinct-page">
        <h1>Key Refresh — Distinct</h1>
        <KeyRefreshWidget id="A" loaderKey="a" />
        <KeyRefreshWidget id="B" loaderKey="b" withButton={false} />
      </div>
    ),
    { name: "keyRefreshDistinct" },
  ),
  path(
    "/key-refresh-nokey",
    () => (
      <div data-testid="key-refresh-nokey-page">
        <h1>Key Refresh — No Key</h1>
        <KeyRefreshWidget id="A" />
        <KeyRefreshWidget id="B" withButton={false} />
      </div>
    ),
    { name: "keyRefreshNokey" },
  ),
  path(
    "/key-refresh-error",
    () => (
      <div data-testid="key-refresh-error-page">
        <h1>Key Refresh — Error</h1>
        <KeyRefreshErrorWidget id="A" loaderKey="errgrp" withButton />
        <KeyRefreshErrorWidget id="B" loaderKey="errgrp" withButton={false} />
      </div>
    ),
    { name: "keyRefreshError" },
  ),
  path(
    "/key-refresh-registered",
    () => (
      <div data-testid="key-refresh-registered-page">
        <h1>Key Refresh — Registered</h1>
        <KeyRefreshRegisteredWidget id="A" loaderKey="reg" withButton />
        <KeyRefreshRegisteredWidget id="B" loaderKey="reg" />
        <KeyRefreshRegisteredWidget id="C" />
      </div>
    ),
    { name: "keyRefreshRegistered" },
    () => [loader(KeyRefreshRegisteredLoader)],
  ),
  layout(KeyRefreshLifeLayout, () => [
    path(
      "/key-refresh-life/a",
      () => (
        <div data-testid="key-refresh-life-a">
          <KeyRefreshWidget id="scoped" loaderKey="scoped" />
        </div>
      ),
      { name: "keyRefreshLifeA" },
    ),
    path(
      "/key-refresh-life/b",
      () => <div data-testid="key-refresh-life-b">B</div>,
      { name: "keyRefreshLifeB" },
    ),
  ]),
  path("/key-refresh-group", () => <KeyRefreshGroupPage />, {
    name: "keyRefreshGroup",
  }),
  // Multi-tag: one read tagged into several groups; a fine tag refreshes a
  // subset, the coarse tag or the union argument refreshes the whole set.
  path("/key-refresh-multitag", () => <KeyRefreshMultiTagPage />, {
    name: "keyRefreshMultiTag",
  }),
  // Regression: a grouped no-key reader that loaded itself must still update on
  // a group refresh (load() and the group refresh must share the same bucket).
  path(
    "/key-refresh-group-load",
    () => (
      <div data-testid="key-refresh-group-load-page">
        <h1>Key Refresh — Group + own load()</h1>
        <KeyRefreshWidget id="GL" refreshGroup="g2" withButton />
        <KeyRefreshGroupButton id="g2" group="g2" />
      </div>
    ),
    { name: "keyRefreshGroupLoad" },
  ),
  // Widened key semantics: a keyed parameterized GET shares within the key.
  path(
    "/key-refresh-params",
    () => (
      <div data-testid="key-refresh-params-page">
        <h1>Key Refresh — Keyed Params</h1>
        <KeyRefreshParamWidget id="A" loaderKey="ptag" mode="get" tag="alpha" />
        <KeyRefreshParamWidget
          id="B"
          loaderKey="ptag"
          mode="get"
          tag="alpha"
          withButton={false}
        />
      </div>
    ),
    { name: "keyRefreshParams" },
  ),
  // Widened key semantics: a keyed mutation (POST/body) stays local.
  path(
    "/key-refresh-mutation",
    () => (
      <div data-testid="key-refresh-mutation-page">
        <h1>Key Refresh — Keyed Mutation</h1>
        <KeyRefreshParamWidget
          id="A"
          loaderKey="mtag"
          mode="post"
          tag="posted"
        />
        <KeyRefreshParamWidget
          id="B"
          loaderKey="mtag"
          mode="post"
          tag="posted"
          withButton={false}
        />
      </div>
    ),
    { name: "keyRefreshMutation" },
  ),
  // Leak guard: a grouped reader with NO key must not leak a group refresh into
  // an unrelated unkeyed reader of the same loader (private bucket).
  path(
    "/key-refresh-group-private",
    () => (
      <div data-testid="key-refresh-group-private-page">
        <h1>Key Refresh — Group Private Bucket</h1>
        <KeyRefreshWidget id="G" refreshGroup="priv" withButton={false} />
        <KeyRefreshWidget id="U" withButton={false} />
        <KeyRefreshGroupButton id="priv" group="priv" />
      </div>
    ),
    { name: "keyRefreshGroupPrivate" },
  ),
]);
