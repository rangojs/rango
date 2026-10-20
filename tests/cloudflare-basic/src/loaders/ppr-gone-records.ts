// Issue #1213 fixture state (loaders/ppr-gone.ts): the record ids deleted
// through /ppr-gone-delete/:id. Kept apart from the loader module so that
// module exports only loaders.

export const pprGoneDeleted: Set<string> = new Set();
