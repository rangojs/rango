// Issue #1213 fixture state (shell-cache-gone.tsx): the record ids deleted
// through /shell-cache/gone-delete/:id. Kept apart from the loader module so
// that module exports only loaders.

export const shellGoneDeleted: Set<string> = new Set();
