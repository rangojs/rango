import { createRouter } from "@rangojs/router";
import { Document } from "./document.js";
import { appBPatterns } from "./urls.js";
import type { AppBindings } from "../../env.js";

// app-b opts into the theme system; the site app (the cross-app source) does
// not. Used by the cross-app theme regression test: under the old soft switch
// app-b's theme runtime never mounted (the segment tree ran under the source
// app's ThemeProvider), so app-b's <html> theme attribute was missing. The full
// document reload fixes it — app-b loads fresh and its theme attribute applies.
export const router = createRouter<AppBindings>({
  document: Document,
  theme: { attribute: "data-theme", defaultTheme: "dark" },
}).routes(appBPatterns);
