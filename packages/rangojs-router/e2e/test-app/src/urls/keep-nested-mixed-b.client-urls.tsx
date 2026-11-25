"use client";

import { clientUrls } from "@rangojs/router/client";
import { KnPage, KnSection } from "./keep-nested.client.js";
import { KnB1Loader, KnB2Loader, KnB3Loader } from "./keep-nested.loaders.js";

// SPIKE (kept pages, part E): section B of the mixed variant, a
// clientUrls() group under the server outer layout (keep-nested.tsx).
const V = "mixed";

const Section = () => <KnSection variant={V} section="b" />;
const P1 = () => <KnPage variant={V} page="b1" />;
const P2 = () => <KnPage variant={V} page="b2" />;
const P3 = () => <KnPage variant={V} page="b3" />;

export default clientUrls(({ layout, path, loader }) => [
  layout(Section, () => [
    path("/1", P1, { name: "b1" }, () => [loader(KnB1Loader)]),
    path("/2", P2, { name: "b2" }, () => [loader(KnB2Loader)]),
    path("/3", P3, { name: "b3" }, () => [loader(KnB3Loader)]),
  ]),
]);
