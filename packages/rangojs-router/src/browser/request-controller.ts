import type { RequestController, DisposableAbortController } from "./types.js";

// Polyfill Symbol.dispose for Safari and older browsers
if (typeof Symbol.dispose === "undefined") {
  (Symbol as any).dispose = Symbol("Symbol.dispose");
}

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
  // Navigation controllers - aborted on new navigation
  // Using WeakRef to allow GC if controller is no longer referenced elsewhere
  const controllers: WeakRef<AbortController>[] = [];
  // Action controllers - NOT aborted by navigation, only by errors
  const actionControllers: WeakRef<AbortController>[] = [];

  /**
   * Remove stale (garbage collected) refs from an array
   */
  function pruneStaleRefs(refs: WeakRef<AbortController>[]): void {
    for (let i = refs.length - 1; i >= 0; i--) {
      if (!refs[i].deref()) {
        refs.splice(i, 1);
      }
    }
  }

  return {
    /**
     * Create a new abort controller and track it for navigation
     *
     * @returns A new AbortController
     */
    create(): AbortController {
      const controller = new AbortController();
      controllers.push(new WeakRef(controller));
      console.log(
        `[Browser] Created abort controller, total: ${controllers.length}`,
      );
      return controller;
    },

    /**
     * Create a disposable abort controller for navigation use with `using` keyword
     *
     * The controller will be automatically removed from tracking when
     * it goes out of scope, regardless of how the scope is exited.
     *
     * @returns A DisposableAbortController
     *
     * @example
     * ```typescript
     * async function handleNavigation() {
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
     * Create a disposable abort controller for actions
     *
     * Action controllers are NOT aborted by navigation - they complete
     * independently. Only aborted by abortAllActions() on error.
     *
     * @returns A DisposableAbortController
     */
    createActionDisposable(): DisposableAbortController {
      const controller = new AbortController();
      const ref = new WeakRef(controller);
      actionControllers.push(ref);
      console.log(
        `[Browser] Created action controller, total: ${actionControllers.length}`,
      );
      return {
        controller,
        [Symbol.dispose]: () => {
          const index = actionControllers.indexOf(ref);
          if (index !== -1) {
            actionControllers.splice(index, 1);
            console.log(
              `[Browser] Removed action controller, remaining: ${actionControllers.length}`,
            );
          }
        },
      };
    },

    /**
     * Abort all navigation controllers (NOT actions)
     *
     * Called when starting new navigation. Actions continue
     * to complete in the background.
     */
    abortAll(): void {
      controllers.forEach((ref) => ref.deref()?.abort());
      controllers.length = 0;
      console.log(`[Browser] Aborted all navigation controllers`);
    },

    /**
     * Abort all action controllers
     *
     * Called when an action error occurs - prevents other actions
     * from completing and overwriting the error UI.
     */
    abortAllActions(): void {
      actionControllers.forEach((ref) => ref.deref()?.abort());
      actionControllers.length = 0;
      console.log(`[Browser] Aborted all action controllers`);
    },

    /**
     * Remove a specific controller from tracking
     *
     * Call this when a request completes successfully.
     *
     * @param controller - The controller to remove
     */
    remove(controller: AbortController): void {
      // Prune any stale refs while searching
      pruneStaleRefs(controllers);
      const index = controllers.findIndex((ref) => ref.deref() === controller);
      if (index !== -1) {
        controllers.splice(index, 1);
        console.log(
          `[Browser] Removed abort controller, remaining: ${controllers.length}`,
        );
      }
    },
  };
}
