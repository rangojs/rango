import { getRequestContext } from "@rangojs/router";

// Loaded by urls/dev-reload-split.tsx after its probe: reads the request
// context of the module copy it evaluates in.
export function requestPathname(): string {
  return getRequestContext().url.pathname;
}
