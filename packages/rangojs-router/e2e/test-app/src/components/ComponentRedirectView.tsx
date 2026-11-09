"use client";

import type { ReactNode } from "react";
import { useLocationState } from "@rangojs/router/client";
import { ComponentRedirectFlash } from "./component-redirect.js";

/** The sign-in page the account gate sends a signed-out visitor to. */
export function ComponentRedirectLogin(): ReactNode {
  const flash = useLocationState(ComponentRedirectFlash);
  return (
    <main data-testid="cr-login">
      <h1>Sign in</h1>
      <p data-testid="cr-login-flash">{flash?.text ?? "none"}</p>
    </main>
  );
}
