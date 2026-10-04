"use client";

import { useHandle } from "@rangojs/router/client";
import { DepCrumbs } from "../handles/dep-crumbs.js";

export function DepCrumbsView() {
  const crumbs = useHandle(DepCrumbs);
  return <p data-testid="dep-crumbs">{crumbs.join(",")}</p>;
}
