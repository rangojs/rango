import type { ConsoleMessage, Page } from "@playwright/test";

/**
 * Fail on any hydration / React-render console error or pageerror. Pins the
 * PPR consistency contract: a cached prelude served ahead of a freshly
 * rendered hydration payload must not drift, and a HIT must never trip the
 * app's root error boundary.
 *
 * One canonical string list, shared by every suite. It matched only
 * "Minified React error" once, so dev's unminified "An unsupported type was
 * passed to use()" (#438, the settled-marker regression) sailed through one
 * suite while the other had already drifted to a broader copy. The
 * "[RootErrorBoundary]" prefix is logged by the router's own boundary
 * (src/root-error-boundary.tsx), so it is app-independent.
 *
 * Use with `using` so the assertion runs at scope exit — and make sure
 * hydration happens INSIDE the scope (goto alone can pass assertions off the
 * SSR DOM before hydration errors fire; await the suite's waitForHydration
 * first).
 */
export function guardHydrationErrors(page: Page): {
  [Symbol.dispose]: () => void;
} {
  const errors: string[] = [];
  const isHydrationError = (text: string) =>
    text.includes("hydration") ||
    text.includes("Hydration") ||
    text.includes("Minified React error") ||
    text.includes("unsupported type was passed to use") ||
    text.includes("[RootErrorBoundary]");
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() === "error" && isHydrationError(msg.text())) {
      errors.push(msg.text());
    }
  };
  const onPageError = (err: Error) => {
    if (isHydrationError(err.message)) errors.push(err.message);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  return {
    [Symbol.dispose]: () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      if (errors.length > 0) {
        throw new Error(
          `hydration / React errors on a PPR page:\n${errors.join("\n")}`,
        );
      }
    },
  };
}
