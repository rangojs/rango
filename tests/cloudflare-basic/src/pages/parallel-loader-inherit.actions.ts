"use server";

// parallel-loader-inherit.test.ts: an action that changes nothing, so its
// revalidation re-runs the route's handler and holds the route's loader.
export async function parallelInheritTouch(): Promise<void> {}
