"use server";

/** No-op server action: the gtm e2e uses it to prove an action's revalidation sends no page_view. */
export async function gtmPing(): Promise<void> {}
