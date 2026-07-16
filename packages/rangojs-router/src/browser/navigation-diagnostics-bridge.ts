import type {
  BrowserNavigationKind,
  BrowserNavigationRequestRole,
} from "../router/diagnostics/browser-protocol.js";

declare const __RANGO_DEV_DIAGNOSTICS__: boolean;

export const BROWSER_NAVIGATION_DIAGNOSTICS_ENABLED: boolean =
  typeof __RANGO_DEV_DIAGNOSTICS__ !== "undefined" && __RANGO_DEV_DIAGNOSTICS__;

export interface BrowserNavigationDiagnosticRef {
  id: string;
  kind: BrowserNavigationKind;
  pathname: string;
}

export interface BrowserNavigationDiagnosticsApi {
  start(
    kind: BrowserNavigationKind,
    pathname: string,
    existingId?: string,
  ): BrowserNavigationDiagnosticRef;
  linkResponse(
    navigation: BrowserNavigationDiagnosticRef,
    response: Response,
    role: BrowserNavigationRequestRole,
  ): void;
  linkRequest(
    navigation: BrowserNavigationDiagnosticRef,
    requestId: string | null,
    role: BrowserNavigationRequestRole,
  ): void;
  complete(navigation: BrowserNavigationDiagnosticRef): void;
  abort(navigation: BrowserNavigationDiagnosticRef, failed?: boolean): void;
}

let api: BrowserNavigationDiagnosticsApi | null = null;

export function registerBrowserNavigationDiagnostics(
  next: BrowserNavigationDiagnosticsApi,
): void {
  api = next;
}

export function getBrowserNavigationDiagnostics(): BrowserNavigationDiagnosticsApi | null {
  return BROWSER_NAVIGATION_DIAGNOSTICS_ENABLED ? api : null;
}
