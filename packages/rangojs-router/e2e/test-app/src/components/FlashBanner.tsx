"use client";

import { useActionState } from "react";
import { useLocationState } from "@rangojs/router/client";
import { FlashMessage, ServerInfo } from "../location-states.js";
import {
  saveAndRedirect,
  actionSimpleRedirect,
  throwRedirectWithState,
  throwSimpleRedirect,
  throwActionError,
  throwFormActionError,
} from "../actions.js";

export function FlashBanner() {
  const flash = useLocationState(FlashMessage);
  return (
    <div data-testid="flash-banner">
      {flash ? (
        <p data-testid="flash-text">{flash.text}</p>
      ) : (
        <p data-testid="flash-empty">No flash message</p>
      )}
    </div>
  );
}

export function ActionRedirectButton() {
  return (
    <button data-testid="action-redirect-btn" onClick={() => saveAndRedirect()}>
      Save and redirect
    </button>
  );
}

export function ActionSimpleRedirectButton() {
  return (
    <button
      data-testid="action-simple-redirect-btn"
      onClick={() => actionSimpleRedirect()}
    >
      Simple redirect
    </button>
  );
}

export function ThrowRedirectButton() {
  return (
    <button
      data-testid="throw-redirect-btn"
      onClick={() => throwRedirectWithState()}
    >
      Throw redirect with state
    </button>
  );
}

export function ThrowSimpleRedirectButton() {
  return (
    <button
      data-testid="throw-simple-redirect-btn"
      onClick={() => throwSimpleRedirect()}
    >
      Throw simple redirect
    </button>
  );
}

export function ThrowErrorButton() {
  return (
    <button
      data-testid="throw-error-btn"
      onClick={() => throwActionError().catch(() => {})}
    >
      Throw action error
    </button>
  );
}

export function ThrowFormErrorButton() {
  const [, formAction, isPending] = useActionState(throwFormActionError, null);

  return (
    <form action={formAction}>
      <button
        type="submit"
        data-testid="throw-form-error-submit-btn"
        disabled={isPending}
      >
        Throw form action error
      </button>
    </form>
  );
}

export function ServerInfoDisplay() {
  const info = useLocationState(ServerInfo);
  return (
    <div data-testid="server-info">
      {info ? (
        <p data-testid="server-info-data">{info.data}</p>
      ) : (
        <p data-testid="server-info-empty">No server info</p>
      )}
    </div>
  );
}
