/**
 * Route-scale knob for the generated groups (src/groups/).
 *
 * A committed CONSTANT, deliberately not an env var: route counts feed the
 * committed *.gen.ts files (repo hard rule: generated route files are checked
 * in for every app), so an env-dependent count would make them
 * unreproducible and break CI. To change scale: edit this value and/or rerun
 * `node scripts/gen-groups.mjs --groups <n>`, rebuild, and commit the
 * regenerated gen files with it.
 */
export const SCALE: number = 1;
