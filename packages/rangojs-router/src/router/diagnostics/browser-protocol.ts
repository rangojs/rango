export const RANGO_BROWSER_NAVIGATION_EVENT = "rango:diagnostics:navigation";
export const RANGO_BROWSER_NAVIGATION_VERSION = 1 as const;

export type BrowserNavigationKind =
  | "document"
  | "navigate"
  | "refresh"
  | "popstate"
  | "action";

export type BrowserNavigationPhase =
  | "started"
  | "request-linked"
  | "committed"
  | "aborted"
  | "failed";

export type BrowserNavigationRequestRole =
  | "document"
  | "navigation"
  | "prefetch-source"
  | "action"
  | "revalidation";

export interface BrowserNavigationEvent {
  version: typeof RANGO_BROWSER_NAVIGATION_VERSION;
  sequence: number;
  documentId: string;
  navigationId: string;
  kind: BrowserNavigationKind;
  phase: BrowserNavigationPhase;
  pathname: string;
  requestId?: string;
  role?: BrowserNavigationRequestRole;
}
