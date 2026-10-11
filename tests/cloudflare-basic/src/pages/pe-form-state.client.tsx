"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  makeOpaque,
  makeToken,
  type OpaqueState,
  type TokenState,
} from "../actions/pe-form-state.js";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" data-testid="pe-fs-submit" disabled={pending}>
      Make a token
    </button>
  );
}

export function TokenForm() {
  const [state, action] = useActionState<TokenState, FormData>(makeToken, null);
  const [opaque, opaqueAction] = useActionState<OpaqueState, FormData>(
    makeOpaque,
    null,
  );
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <div>
      <form action={action}>
        <Submit />
        {state?.token && <p data-testid="pe-fs-token">{state.token}</p>}
      </form>
      <form action={opaqueAction}>
        <button type="submit" data-testid="pe-fs-opaque-submit">
          Make an opaque result
        </button>
        {opaque && <p data-testid="pe-fs-opaque">{opaque.label}</p>}
      </form>
      <p data-testid="pe-fs-hydrated">{hydrated ? "yes" : "no"}</p>
    </div>
  );
}
