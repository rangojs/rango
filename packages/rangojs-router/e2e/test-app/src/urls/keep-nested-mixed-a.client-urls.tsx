"use client";

import { clientUrls } from "@rangojs/router/client";
import { KnPage, KnSection } from "./keep-nested.client.js";
import { KnA1Loader, KnA2Loader, KnA3Loader } from "./keep-nested.loaders.js";

// SPIKE (kept pages, part E): section A of the mixed variant, a
// clientUrls() group under the server outer layout (keep-nested.tsx).
const V = "mixed";

const Section = () => <KnSection variant={V} section="a" />;
const P1 = () => <KnPage variant={V} page="a1" />;
const P2 = () => <KnPage variant={V} page="a2" />;
const P3 = () => <KnPage variant={V} page="a3" />;

export default clientUrls(({ layout, path, loader }) => [
  layout(Section, () => [
    path("/1", P1, { name: "a1" }, () => [loader(KnA1Loader)]),
    path("/2", P2, { name: "a2" }, () => [loader(KnA2Loader)]),
    path("/3", P3, { name: "a3" }, () => [loader(KnA3Loader)]),
  ]),
]);
