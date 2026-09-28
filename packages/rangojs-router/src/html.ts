/**
 * Members of the `Html` namespace; client.tsx and client.rsc.tsx expose this
 * module as `import * as Html`. A module namespace, not an object literal, so
 * bundlers drop members an app never renders (a literal kept opt-in
 * ScrollRestoration in every app: +313 B gzip, over the router-chunk ratchet).
 * No "use client": each member stays its own module's client reference, so a
 * server component can dot into `Html`. Pinned by __tests__/html.test.ts and
 * testing/__tests__/html-namespace.rsc-test.tsx.
 */
export { MetaTags as Meta } from "./handles/MetaTags.js";
export { Scripts } from "./handles/Scripts.js";
export { ScrollRestoration } from "./browser/react/ScrollRestoration.js";
