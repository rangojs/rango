import type { RequestController, DisposableAbortController } from "./types.js";

/**
 * Create a request controller for managing concurrent abort controllers
 *
 * This utility helps manage concurrent navigation requests by providing
 * a way to abort all pending requests when a new navigation starts.
 *
 * @returns RequestController instance
 *
 * @example
 * ```typescript
 * const controller = createRequestController();
 *
 * // Start a new request
 * const abortController = controller.create();
 * fetch(url, { signal: abortController.signal });
 *
 * // Abort all pending requests (e.g., when starting new navigation)
 * controller.abortAll();
 *
 * // Clean up completed request
 * controller.remove(abortController);
 * ```
 */
export function createRequestController(): RequestController {
  const controllers: AbortController[] = [];

  return {
    /**
     * Create a new abort controller and track it
     *
     * @returns A new AbortController
     */
    create(): AbortController {
      const controller = new AbortController();
      controllers.push(controller);
      console.log(`[Browser] Created abort controller, total: ${controllers.length}`);
      return controller;
    },

    /**
     * Create a disposable abort controller for use with `using` keyword
     *
     * The controller will be automatically removed from tracking when
     * it goes out of scope, regardless of how the scope is exited.
     *
     * @returns A DisposableAbortController
     *
     * @example
     * ```typescript
     * async function handleRequest() {
     *   requestController.abortAll();
     *   using { controller } = requestController.createDisposable();
     *   // ... use controller.signal ...
     *   // controller is automatically removed on scope exit
     * }
     * ```
     */
    createDisposable(): DisposableAbortController {
      const controller = this.create();
      return {
        controller,
        [Symbol.dispose]: () => {
          this.remove(controller);
        },
      };
    },

    /**
     * Abort all tracked controllers
     *
     * Useful when starting a new navigation that should cancel
     * any pending requests.
     */
    abortAll(): void {
      controllers.forEach((controller) => controller.abort());
      controllers.length = 0;
      console.log(`[Browser] Aborted all controllers`);
    },

    /**
     * Remove a specific controller from tracking
     *
     * Call this when a request completes successfully.
     *
     * @param controller - The controller to remove
     */
    remove(controller: AbortController): void {
      const index = controllers.indexOf(controller);
      if (index !== -1) {
        controllers.splice(index, 1);
        console.log(`[Browser] Removed abort controller, remaining: ${controllers.length}`);
      }
    },
  };
}
