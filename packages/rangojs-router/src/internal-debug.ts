// Internal monorepo debug gate.
// Kept out of public API on purpose.
export const INTERNAL_DEBUG: boolean = Boolean((import.meta as any).env?.DEV);
