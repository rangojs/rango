"use client";

import { clientUrls } from "@rangojs/router/client";
import { KnPage, KnSection } from "./keep-nested.client.js";
import { KnC1Loader } from "./keep-nested.loaders.js";

// SPIKE (kept pages, part E): section C of the mixed variant, a
// clientUrls() group under the server outer layout (keep-nested.tsx).
const V = "mixed";

const Section = () => <KnSection variant={V} section="c" />;
const P1 = () => <KnPage variant={V} page="c1" />;

export default clientUrls(({ layout, path, loader }) => [
  layout(Section, () => [
    path("/1", P1, { name: "c1" }, () => [loader(KnC1Loader)]),
  ]),
]);
