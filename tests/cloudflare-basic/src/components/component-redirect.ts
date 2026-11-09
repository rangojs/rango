import { createLocationState } from "@rangojs/router";

// Shared by the component-redirect server routes and their client reader.
// Not a "use client" module: the server needs the definition itself.

/** The state the account gate's redirect() carries to the sign-in page. */
export const ComponentRedirectFlash = createLocationState<{ text: string }>();
