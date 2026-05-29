"use client";

import { Component, type ReactNode } from "react";
import { useFetchLoader } from "@rangojs/router/client";
import { KeyRefreshErrorLoader } from "../loaders.js";

class WidgetErrorBoundary extends Component<
  { id: string; children: ReactNode },
  { thrown: string | null }
> {
  state = { thrown: null as string | null };
  static getDerivedStateFromError(err: Error): { thrown: string } {
    return { thrown: err.message };
  }
  render(): ReactNode {
    if (this.state.thrown !== null) {
      return (
        <div data-testid={`key-refresh-err-${this.props.id}-fallback`}>
          {this.state.thrown}
        </div>
      );
    }
    return this.props.children;
  }
}

interface InnerProps {
  id: string;
  withButton: boolean;
  loaderKey: string;
}

function Inner({ id, withButton, loaderKey }: InnerProps) {
  // Both readers use throwOnError: true (the default). The keyed group shares
  // the failing snapshot, but only the hook that initiated the load() throws;
  // the sibling exposes the same error via `error` without throwing.
  const { error, load } = useFetchLoader(KeyRefreshErrorLoader, {
    key: loaderKey,
  });
  return (
    <div data-testid={`key-refresh-err-${id}`}>
      <span data-testid={`key-refresh-err-${id}-error`}>
        {error ? error.message : "—"}
      </span>
      {withButton && (
        <button
          data-testid={`key-refresh-err-${id}-load-btn`}
          onClick={() => load().catch(() => {})}
        >
          Load
        </button>
      )}
    </div>
  );
}

interface Props {
  id: string;
  withButton: boolean;
  loaderKey: string;
}

/**
 * Two of these share one client refresh key on /key-refresh-error. The one
 * with the button originates a failing load(); it must render-throw into its
 * boundary while the sibling stays mounted and surfaces the error via `error`.
 * Pins the keyed analogue of the shared-refetch originator-only-throw contract,
 * here for an UNREGISTERED loader (sharing exists only because of the key).
 */
export function KeyRefreshErrorWidget({ id, withButton, loaderKey }: Props) {
  return (
    <WidgetErrorBoundary id={id}>
      <Inner id={id} withButton={withButton} loaderKey={loaderKey} />
    </WidgetErrorBoundary>
  );
}
