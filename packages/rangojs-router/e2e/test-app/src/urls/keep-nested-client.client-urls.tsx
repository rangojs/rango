"use client";

import { clientUrls } from "@rangojs/router/client";
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

// SPIKE (kept pages, part E): nested keeping outlets in one clientUrls()
// group: an outer layout over four section layouts.
const V = "client";

const Outer = () => <KnOuter variant={V} />;
const SectionA = () => <KnSection variant={V} section="a" />;
const SectionB = () => <KnSection variant={V} section="b" />;
const SectionC = () => <KnSection variant={V} section="c" />;
const SectionD = () => <KnSection variant={V} section="d" />;
const A1 = () => <KnPage variant={V} page="a1" />;
const A2 = () => <KnPage variant={V} page="a2" />;
const A3 = () => <KnPage variant={V} page="a3" />;
const B1 = () => <KnPage variant={V} page="b1" />;
const B2 = () => <KnPage variant={V} page="b2" />;
const B3 = () => <KnPage variant={V} page="b3" />;
const C1 = () => <KnPage variant={V} page="c1" />;
const D1 = () => <KnPage variant={V} page="d1" />;

export default clientUrls(({ layout, path, loader }) => [
  layout(Outer, () => [
    layout(SectionA, () => [
      path("/a/1", A1, { name: "a1" }, () => [loader(KnA1Loader)]),
      path("/a/2", A2, { name: "a2" }, () => [loader(KnA2Loader)]),
      path("/a/3", A3, { name: "a3" }, () => [loader(KnA3Loader)]),
    ]),
    layout(SectionB, () => [
      path("/b/1", B1, { name: "b1" }, () => [loader(KnB1Loader)]),
      path("/b/2", B2, { name: "b2" }, () => [loader(KnB2Loader)]),
      path("/b/3", B3, { name: "b3" }, () => [loader(KnB3Loader)]),
    ]),
    layout(SectionC, () => [
      path("/c/1", C1, { name: "c1" }, () => [loader(KnC1Loader)]),
    ]),
    layout(SectionD, () => [
      path("/d/1", D1, { name: "d1" }, () => [loader(KnD1Loader)]),
    ]),
  ]),
]);
