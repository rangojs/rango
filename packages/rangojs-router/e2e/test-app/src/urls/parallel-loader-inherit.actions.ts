"use server";

/**
 * /parallel-loader-inherit-*: an action that changes nothing, so its
 * revalidation re-runs the route's loaders and holds what declines.
 */
export async function parallelInheritTouch(): Promise<void> {}
