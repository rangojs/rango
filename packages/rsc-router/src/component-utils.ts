/**
 * Component utilities for RSC
 *
 * Helpers for working with React Server Components and client components.
 */

import type { ComponentType } from "react";

/**
 * Symbol used by React to mark client component references.
 * When a file has "use client" directive, the bundler transforms the exports
 * to include this symbol on $$typeof.
 */
const CLIENT_REFERENCE = Symbol.for("react.client.reference");

/**
 * Check if a component is a client component (has "use client" directive).
 *
 * Client components are marked by the bundler with:
 * - $$typeof: Symbol.for("react.client.reference")
 * - $$id: string (module identifier)
 *
 * @param component - The component to check
 * @returns true if the component has client reference marker
 *
 * @example
 * ```typescript
 * import { MyComponent } from "./my-component"; // has "use client"
 *
 * if (!isClientComponent(MyComponent)) {
 *   throw new Error("MyComponent must be a client component");
 * }
 * ```
 */
export function isClientComponent(
  component: ComponentType<unknown> | unknown
): boolean {
  if (typeof component !== "function") {
    return false;
  }
  const withMeta = component as { $$typeof?: symbol };
  return withMeta.$$typeof === CLIENT_REFERENCE;
}

/**
 * Assert that a component is a client component.
 * Throws a descriptive error if not.
 *
 * @param component - The component to check
 * @param name - Name to use in error message (e.g., "document")
 * @throws Error if the component is not a client component
 */
export function assertClientComponent(
  component: ComponentType<unknown> | unknown,
  name: string
): asserts component is ComponentType<unknown> {
  if (typeof component !== "function") {
    throw new Error(
      `${name} must be a client component function with "use client" directive. ` +
        `Make sure to pass the component itself, not a JSX element: ` +
        `${name}: My${capitalize(name)} (correct) vs ${name}: <My${capitalize(name)} /> (incorrect)`
    );
  }

  if (!isClientComponent(component)) {
    throw new Error(
      `${name} must be a client component with "use client" directive at the top of the file. ` +
        `Server components cannot be used as the ${name} because their function reference ` +
        `cannot be serialized in the RSC payload. Add "use client" to your ${name} file.`
    );
  }
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
