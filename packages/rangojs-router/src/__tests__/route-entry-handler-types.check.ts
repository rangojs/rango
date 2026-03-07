/**
 * Type-level tests for RouteEntry handler shapes.
 * Verified by tsc --noEmit.
 *
 * Supported shapes:
 *   - sync: () => Array<AllUseItems>
 *   - lazy import: () => Promise<{ default: () => Array<AllUseItems> }>
 *   - lazy function: () => Promise<() => Array<AllUseItems>>
 *
 * Direct Promise<Array<AllUseItems>> is rejected at runtime (P31).
 * The type system alone cannot distinguish Promise<Array> from
 * Promise<() => Array> due to structural compatibility, so the
 * runtime guard is essential.
 */

import type { RouteEntry } from "../types/route-entry.js";
import type { AllUseItems } from "../route-types.js";

// --- Positive: supported handler shapes ---

const syncHandler: RouteEntry["handler"] = () => [] as AllUseItems[];

const lazyImport: RouteEntry["handler"] = () =>
  Promise.resolve({ default: () => [] as AllUseItems[] });

const lazyFunction: RouteEntry["handler"] = () =>
  Promise.resolve(() => [] as AllUseItems[]);

// --- Negative: async function returning array directly is rejected ---

// @ts-expect-error — async () => Array is not a supported handler shape
const asyncFn: RouteEntry["handler"] = async () => [] as AllUseItems[];

// Suppress unused variable warnings
void syncHandler;
void lazyImport;
void lazyFunction;
void asyncFn;
