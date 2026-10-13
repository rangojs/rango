"use server";

/** The action the stats loader's revalidate() predicate matches. */
export async function bumpComponentUseStats(): Promise<void> {}

/** Any other action: the default would re-run the loader, the predicate holds it. */
export async function otherComponentUseAction(): Promise<void> {}
