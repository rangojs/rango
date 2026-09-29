"use client";

import { useLoader } from "@rangojs/router/client";
import { PprNavPinLoader } from "../loaders/ppr-shell.js";

/** The /ppr-nav-pin bake-lane value, as the payload delivers it. */
export function PprNavPinView() {
  const {
    data: { baked },
  } = useLoader(PprNavPinLoader);
  return <p data-testid="ppr-nav-pin-baked">{baked}</p>;
}
