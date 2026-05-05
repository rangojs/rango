"use client";

import { Component, type ReactNode } from "react";
import { useFetchLoader, type LoaderDefinition } from "@rangojs/router/client";
import {
  SharedRefetchErrorLoader,
  SharedRefetchErrorMixedLoader,
} from "../loaders.js";

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
        <div data-testid={`shared-refetch-err-${this.props.id}-fallback`}>
          {this.state.thrown}
        </div>
      );
    }
    return this.props.children;
  }
}

const LOADERS = {
  default: SharedRefetchErrorLoader,
  mixed: SharedRefetchErrorMixedLoader,
} as const;

interface InnerProps {
  id: string;
  withButton: boolean;
  throwOnError: boolean;
  loader: LoaderDefinition<unknown>;
}

function Inner({ id, withButton, throwOnError, loader }: InnerProps) {
  const { error, load } = useFetchLoader(loader, { throwOnError });
  return (
    <div data-testid={`shared-refetch-err-${id}`}>
      <span data-testid={`shared-refetch-err-${id}-error`}>
        {error ? error.message : "—"}
      </span>
      {withButton && (
        <button
          data-testid={`shared-refetch-err-${id}-load-btn`}
          onClick={() => {
            // Fire-and-forget; the failure surfaces via the shared store /
            // local error state and is rendered in the parent boundary.
            load().catch(() => {});
          }}
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
  throwOnError?: boolean;
  variant?: keyof typeof LOADERS;
}

/**
 * Sibling reads of a loader that throws on refetch. The component with
 * `withButton` triggers the failing load(); both subscribe to the shared
 * snapshot. Test asserts:
 *   - `throwOnError: true` originator render-throws → boundary catches.
 *   - `throwOnError: false` originator does NOT render-throw → its inner
 *     stays mounted with `error.message` visible.
 *   - Sibling (regardless of `throwOnError`) does NOT throw because it
 *     did not originate the failing request — it just exposes `error`.
 */
export function SharedRefetchErrorWidget({
  id,
  withButton,
  throwOnError = true,
  variant = "default",
}: Props) {
  return (
    <WidgetErrorBoundary id={id}>
      <Inner
        id={id}
        withButton={withButton}
        throwOnError={throwOnError}
        loader={LOADERS[variant]}
      />
    </WidgetErrorBoundary>
  );
}
