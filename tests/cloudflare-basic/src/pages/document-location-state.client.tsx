"use client";

import { useEffect, useState } from "react";
import { useLocationState } from "@rangojs/router/client";
import { DocumentFlash } from "../location-states.js";
import {
  flashInPlace,
  redirectWithFlash,
} from "../actions/document-location-state.js";

export function DocumentStateBanner() {
  const flash = useLocationState(DocumentFlash);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <div>
      <p data-testid="ds-flash">{flash?.text ?? "none"}</p>
      <p data-testid="ds-hydrated">{hydrated ? "yes" : "no"}</p>
    </div>
  );
}

export function DocumentStateForms() {
  return (
    <div>
      <form action={redirectWithFlash}>
        <button type="submit" data-testid="ds-redirect-submit">
          Pay and redirect
        </button>
      </form>
      <form action={flashInPlace}>
        <button type="submit" data-testid="ds-inplace-submit">
          Save in place
        </button>
      </form>
    </div>
  );
}
