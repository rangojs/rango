"use client";

import { useActionState } from "react";
import { actionRedirectLogin } from "../actions.jsx";

export function ActionRedirectLoginForm() {
  const [state, formAction, isPending] = useActionState(actionRedirectLogin, undefined);

  return (
    <div data-testid="login-form">
      <form action={formAction}>
        {state?.error && (
          <div data-testid="login-error">{state.error}</div>
        )}
        <input
          name="email"
          type="email"
          placeholder="test@test.com"
          data-testid="login-email"
        />
        <button type="submit" disabled={isPending} data-testid="login-submit">
          {isPending ? "Logging in..." : "Log in"}
        </button>
      </form>
    </div>
  );
}
