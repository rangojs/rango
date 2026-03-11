import { Outlet } from "@rangojs/router/client";
import { ThemeProvider } from "fake-context-lib";

/**
 * Server component layout that wraps children with ThemeProvider from
 * fake-context-lib. Since fake-context-lib/internal/context.js has "use client",
 * the RSC plugin creates a client-in-server-package-proxy for this import.
 *
 * The client-ref-dedup plugin ensures the proxy and direct client imports
 * resolve to the same module instance in dev mode.
 */
export function ContextDedupLayout() {
  return (
    <div data-testid="context-dedup-layout">
      <ThemeProvider theme="dark-test-theme">
        <Outlet />
      </ThemeProvider>
    </div>
  );
}
