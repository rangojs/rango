import { urls } from "@rangojs/router";
import { KnOuter, KnPage, KnSection } from "./keep-nested.client.js";
import {
  KnA1Loader,
  KnA2Loader,
  KnA3Loader,
  KnB1Loader,
  KnB2Loader,
  KnB3Loader,
  KnC1Loader,
  KnD1Loader,
} from "./keep-nested.loaders.js";
import knMixedA from "./keep-nested-mixed-a.client-urls.js";
import knMixedB from "./keep-nested-mixed-b.client-urls.js";
import knMixedC from "./keep-nested-mixed-c.client-urls.js";
import knMixedD from "./keep-nested-mixed-d.client-urls.js";

// SPIKE (kept pages, part E): nested keeping outlets as server routes, and a
// server outer layout over clientUrls() sections (mixed).

const V = "server";

export const keepNestedServerPatterns = urls(({ layout, path, loader }) => [
  layout(
    () => <KnOuter variant={V} />,
    () => [
      layout(
        () => <KnSection variant={V} section="a" />,
        () => [
          path(
            "/keep-nested/server/a/1",
            () => <KnPage variant={V} page="a1" />,
            { name: "knServerA1" },
            () => [loader(KnA1Loader)],
          ),
          path(
            "/keep-nested/server/a/2",
            () => <KnPage variant={V} page="a2" />,
            { name: "knServerA2" },
            () => [loader(KnA2Loader)],
          ),
          path(
            "/keep-nested/server/a/3",
            () => <KnPage variant={V} page="a3" />,
            { name: "knServerA3" },
            () => [loader(KnA3Loader)],
          ),
        ],
      ),
      layout(
        () => <KnSection variant={V} section="b" />,
        () => [
          path(
            "/keep-nested/server/b/1",
            () => <KnPage variant={V} page="b1" />,
            { name: "knServerB1" },
            () => [loader(KnB1Loader)],
          ),
          path(
            "/keep-nested/server/b/2",
            () => <KnPage variant={V} page="b2" />,
            { name: "knServerB2" },
            () => [loader(KnB2Loader)],
          ),
          path(
            "/keep-nested/server/b/3",
            () => <KnPage variant={V} page="b3" />,
            { name: "knServerB3" },
            () => [loader(KnB3Loader)],
          ),
        ],
      ),
      layout(
        () => <KnSection variant={V} section="c" />,
        () => [
          path(
            "/keep-nested/server/c/1",
            () => <KnPage variant={V} page="c1" />,
            { name: "knServerC1" },
            () => [loader(KnC1Loader)],
          ),
        ],
      ),
      layout(
        () => <KnSection variant={V} section="d" />,
        () => [
          path(
            "/keep-nested/server/d/1",
            () => <KnPage variant={V} page="d1" />,
            { name: "knServerD1" },
            () => [loader(KnD1Loader)],
          ),
        ],
      ),
    ],
  ),
]);

export const keepNestedMixedPatterns = urls(({ layout, include }) => [
  layout(
    () => <KnOuter variant="mixed" />,
    () => [
      include("/keep-nested/mixed/a", knMixedA, { name: "knMixedA" }),
      include("/keep-nested/mixed/b", knMixedB, { name: "knMixedB" }),
      include("/keep-nested/mixed/c", knMixedC, { name: "knMixedC" }),
      include("/keep-nested/mixed/d", knMixedD, { name: "knMixedD" }),
    ],
  ),
]);
